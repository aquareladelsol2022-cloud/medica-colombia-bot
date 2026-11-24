import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { initWhatsAppClient, sendWhatsAppMessage, sendWhatsAppImage, downloadWhatsAppMedia, latestQrUrl, isWhatsAppConnected, requestPairing, botMessageIds } from './services/whatsapp.service';
import { generateAIResponse, transcribeAudio, resetConversation } from './services/ai.service';
import { quotesService } from './services/quotes.service';

dotenv.config();

const app = express();
const port = process.env.PORT || 3085;

// Control de intervención de asesores humanos (pausa temporal del bot)
export const humanTakeover: Record<string, number> = {};
export const TAKEOVER_TIMEOUT_MS = (parseInt(process.env.HUMAN_TAKEOVER_MINUTES || '15', 10)) * 60 * 1000;

// Deduplicación rápida de mensajes idénticos y buffer anti-respuestas dobles
const lastIncomingText: Record<string, { text: string; time: number }> = {};
interface DebounceQueueItem {
    messages: string[];
    timer: NodeJS.Timeout;
}
const userDebounceQueue: Record<string, DebounceQueueItem> = {};
const activeProcessingChats = new Set<string>();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/status', (req: Request, res: Response) => {
    res.send('🩺 Bot de Médica Colombia S.A.S. (Salud, Cuidado y Hogar) está ACTIVO.');
});

app.post('/api/pairing-code', async (req: Request, res: Response) => {
    try {
        const phone = (req.body?.phone || process.env.OWNER_PHONE || '573153658627').toString().replace(/\D/g, '');
        if (!phone) {
            res.status(400).json({ error: 'Debes proporcionar un número de teléfono válido con indicativo (ej: 573153658627).' });
            return;
        }
        if (isWhatsAppConnected) {
            res.status(400).json({ error: 'WhatsApp ya está conectado actualmente.' });
            return;
        }
        const code = await requestPairing(phone);
        res.json({ ok: true, code, phone });
    } catch (error: any) {
        console.error('Error generando pairing code:', error);
        res.status(500).json({ error: error?.message || 'Error solicitando código de vinculación.' });
    }
});

app.get('/api/qr', (req: Request, res: Response) => {
    if (isWhatsAppConnected) {
        res.send(`
            <!DOCTYPE html>
            <html lang="es">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Médica Colombia - WhatsApp Conectado</title>
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b141a; color: #e9edef; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                    .card { background: #111b21; border: 1px solid #202c33; padding: 40px; border-radius: 20px; text-align: center; max-width: 480px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
                    h2 { color: #25d366; margin-top: 0; font-size: 24px; }
                    p { color: #8696a0; font-size: 15px; line-height: 1.6; }
                </style>
            </head>
            <body>
                <div class="card">
                    <h2>✅ WhatsApp Conectado con Éxito</h2>
                    <p>El bot oficial de <strong>Médica Colombia S.A.S.</strong> está activo y atendiendo a los pacientes en vivo las 24 horas.</p>
                </div>
            </body>
            </html>
        `);
        return;
    }

    res.send(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Vincular WhatsApp - Médica Colombia S.A.S.</title>
            <style>
                * { box-sizing: border-box; }
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0b141a; color: #e9edef; margin: 0; padding: 24px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
                .container { background: #111b21; border: 1px solid #222e35; border-radius: 24px; padding: 32px; max-width: 520px; width: 100%; box-shadow: 0 20px 40px rgba(0,0,0,0.4); text-align: center; }
                h1 { font-size: 22px; color: #00a884; margin: 0 0 6px; }
                .subtitle { color: #8696a0; font-size: 14px; margin: 0 0 20px; }
                .tabs { display: flex; gap: 8px; margin-bottom: 24px; background: #202c33; padding: 4px; border-radius: 12px; }
                .tab-btn { flex: 1; padding: 12px 14px; border: none; background: transparent; color: #8696a0; font-weight: 600; font-size: 14px; border-radius: 8px; cursor: pointer; transition: 0.2s; }
                .tab-btn.active { background: #00a884; color: #fff; }
                .tab-content { display: none; }
                .tab-content.active { display: block; }
                .qr-box { background: white; padding: 14px; border-radius: 16px; display: inline-block; box-shadow: 0 8px 20px rgba(0,0,0,0.3); margin-top: 8px; }
                .qr-box img { display: block; border-radius: 8px; }
                .input-group { display: flex; flex-direction: column; gap: 12px; text-align: left; }
                label { font-size: 13px; color: #8696a0; font-weight: 500; }
                input { width: 100%; padding: 14px; border-radius: 10px; border: 1px solid #2a3942; background: #202c33; color: #fff; font-size: 16px; outline: none; }
                input:focus { border-color: #00a884; }
                button.action-btn { width: 100%; padding: 14px; border-radius: 10px; border: none; background: #00a884; color: #fff; font-size: 15px; font-weight: bold; cursor: pointer; transition: 0.2s; }
                button.action-btn:hover { background: #06cf9c; }
                .code-display { margin-top: 20px; padding: 18px; background: #202c33; border: 2px dashed #00a884; border-radius: 14px; }
                .code-number { font-size: 34px; font-weight: 800; letter-spacing: 4px; color: #25d366; font-family: monospace; }
                .instructions { text-align: left; background: #182229; border-radius: 12px; padding: 14px; margin-top: 18px; font-size: 13px; color: #aebac1; line-height: 1.6; }
                .instructions ol { margin: 8px 0 0; padding-left: 20px; }
                .instructions li { margin-bottom: 4px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🩺 Médica Colombia S.A.S.</h1>
                <div class="subtitle">Vinculación oficial de WhatsApp Business</div>

                <div class="tabs">
                    <button class="tab-btn active" onclick="switchTab('qr')">📷 Escanear QR</button>
                    <button class="tab-btn" onclick="switchTab('code')">🔢 Código de Vinculación</button>
                </div>

                <!-- TAB QR -->
                <div id="tab-qr" class="tab-content active">
                    <p style="color:#8696a0;font-size:14px;margin-bottom:12px;">En WhatsApp: <strong>Dispositivos vinculados > Vincular dispositivo</strong></p>
                    <div class="qr-box">
                        ${latestQrUrl 
                            ? `<img id="qr-img" src="${latestQrUrl}" width="300" height="300" alt="Código QR WhatsApp" />`
                            : `<div style="width:300px;height:300px;display:flex;align-items:center;justify-content:center;color:#333;font-weight:600;">Generando código QR...</div>`
                        }
                    </div>
                    <p style="font-size:12px;color:#8696a0;margin-top:14px;">El código QR se actualiza cada 15 segundos automáticamente.</p>
                </div>

                <!-- TAB CÓDIGO DE VINCULACIÓN -->
                <div id="tab-code" class="tab-content">
                    <p style="color:#8696a0;font-size:14px;margin-bottom:14px;">Ingresa el número oficial con indicativo para recibir tu código de 8 dígitos:</p>
                    <div class="input-group">
                        <label for="phone">Número de WhatsApp (+57):</label>
                        <input type="text" id="phone" value="573153658627" placeholder="573153658627" />
                        <button class="action-btn" id="btn-code" onclick="requestPairingCode()">Generar Código de 8 Dígitos</button>
                    </div>

                    <div id="code-result" style="display:none;" class="code-display">
                        <div style="font-size:12px;color:#8696a0;margin-bottom:6px;">TU CÓDIGO DE VINCULACIÓN ES:</div>
                        <div id="code-text" class="code-number">----</div>
                    </div>

                    <div class="instructions">
                        <strong>Pasos en tu celular (+57 315 365 8627):</strong>
                        <ol>
                            <li>Abre WhatsApp en tu teléfono.</li>
                            <li>Toca los 3 puntos (o Ajustes) > <strong>Dispositivos vinculados</strong>.</li>
                            <li>Toca <strong>Vincular un dispositivo</strong>.</li>
                            <li>En la parte inferior toca <strong>"Vincular con el número de teléfono"</strong> (o "Vincular mediante código").</li>
                            <li>Escribe el código mostrado arriba.</li>
                        </ol>
                    </div>
                </div>
            </div>

            <script>
                function switchTab(tab) {
                    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                    if (tab === 'qr') {
                        document.querySelectorAll('.tab-btn')[0].classList.add('active');
                        document.getElementById('tab-qr').classList.add('active');
                    } else {
                        document.querySelectorAll('.tab-btn')[1].classList.add('active');
                        document.getElementById('tab-code').classList.add('active');
                    }
                }

                async function requestPairingCode() {
                    const phoneInput = document.getElementById('phone');
                    const btn = document.getElementById('btn-code');
                    const resultDiv = document.getElementById('code-result');
                    const codeText = document.getElementById('code-text');

                    const phone = phoneInput.value.trim().replace(/\\D/g, '');
                    if (!phone) {
                        alert('Por favor ingresa un número de teléfono válido.');
                        return;
                    }

                    btn.disabled = true;
                    btn.innerText = 'Generando código...';

                    try {
                        const res = await fetch('/api/pairing-code', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ phone })
                        });
                        const data = await res.json();
                        if (data.ok && data.code) {
                            const formatted = data.code.match(/.{1,4}/g)?.join('-') || data.code;
                            codeText.innerText = formatted;
                            resultDiv.style.display = 'block';
                            btn.innerText = 'Generar nuevo código';
                        } else {
                            alert(data.error || 'No se pudo generar el código. Intenta nuevamente.');
                            btn.innerText = 'Generar Código de 8 Dígitos';
                        }
                    } catch (e) {
                        alert('Error de conexión al generar el código.');
                        btn.innerText = 'Generar Código de 8 Dígitos';
                    } finally {
                        btn.disabled = false;
                    }
                }

                setInterval(async () => {
                    try {
                        const res = await fetch('/api/tickets');
                        const data = await res.json();
                        if (data.whatsappConnected) {
                            window.location.reload();
                        } else if (data.qrUrl) {
                            const img = document.getElementById('qr-img');
                            if (img && img.src !== data.qrUrl) {
                                img.src = data.qrUrl;
                            }
                        }
                    } catch (e) {}
                }, 8000);
            </script>
        </body>
        </html>
    `);
});

app.get('/api/tickets', (req: Request, res: Response) => {
    const activePaused = Object.keys(humanTakeover).filter(k => (Date.now() - humanTakeover[k]) < TAKEOVER_TIMEOUT_MS);
    res.json({ tickets: quotesService.getAllTickets(), whatsappConnected: isWhatsAppConnected, qrUrl: latestQrUrl, pausedChats: activePaused });
});

app.post('/api/reset', (req: Request, res: Response) => {
    const { phone } = req.body || {};
    resetConversation(phone || 'simulador_web_medica');
    res.json({ ok: true });
});

// Endpoint para el Simulador Web (y pruebas de cliente o coordinador)
app.post('/api/chat', async (req: Request, res: Response) => {
    try {
        const { message, phone = 'simulador_web_medica', role = 'client' } = req.body;
        if (!message) {
            res.status(400).json({ error: 'Mensaje vacío' });
            return;
        }

        // Si el usuario en el simulador prueba como Coordinador respondiendo un #Ticket
        if (role === 'coordinator' || /^#\d{3,4}\b/.test(message.trim())) {
            await quotesService.handleCoordinatorMessage(quotesService.coordinatorPhone, message.trim());
            res.json({
                reply: '✅ Respuesta de Coordinación procesada y enviada al paciente.',
                tickets: quotesService.getAllTickets()
            });
            return;
        }

        const activeTicket = quotesService.getActiveCustomerTicket(phone, phone);
        let quoteContext: string | undefined = undefined;
        if (activeTicket) {
            quoteContext = activeTicket.status === 'PENDING'
                ? `Solicitud #${activeTicket.id} PENDIENTE en Coordinación para ${activeTicket.patientInfo} (${activeTicket.service}).`
                : `Solicitud #${activeTicket.id} YA CONFIRMADA para ${activeTicket.patientInfo} (${activeTicket.service}) -> Valor: ${activeTicket.quotePrice}${activeTicket.professional ? ` | Profesional: ${activeTicket.professional}` : ''}${activeTicket.availability ? ` | Horario: ${activeTicket.availability}` : ''}.`;
        }

        const aiReply = await generateAIResponse(phone, message, quoteContext);

        const quoteMatch = aiReply.match(/\[(?:SOLICITAR_COTIZACION|CONSULTAR_COORDINADOR):\s*([^\]]+)\]/i);
        const cleanReplyForClient = aiReply
            .replace(/\[(?:SOLICITAR_COTIZACION|CONSULTAR_COORDINADOR|ESCALAR_HUMANO):[^\]]+\]/gi, '')
            .replace(/\*/g, '')
            .trim();

        let createdTicket = null;
        if (quoteMatch) {
            const parts = quoteMatch[1].split('|').map(s => s.trim());
            const patientInfo = parts[0] || 'Paciente Web';
            const service = parts[1] || 'Servicio Médica Colombia';
            const details = parts[2] || message;
            createdTicket = await quotesService.createTicket(phone, phone, patientInfo, service, details);
        }

        // Solo adjuntar imagen de medios de pago si el cliente pregunta cómo pagar o si Coordinación ya confirmó la cotización/capacidad
        const clientAsksPayment = /(c[oó]mo pago|d[oó]nde pago|a d[oó]nde consigno|link de pago|medios de pago|n[uú]mero de cuenta|cuenta para pagar|datos para transferir)/i.test(message);
        const coordinatorConfirmedPayment = (activeTicket?.status === 'QUOTED') && /(0091267532|073039034|bre-b|banco de occidente)/i.test(cleanReplyForClient);
        const mentionsPayment = clientAsksPayment || coordinatorConfirmedPayment;
        const mentionsRegistration = /(estado civil|ocupaci[oó]n|parentesco|fecha de nacimiento|ingreso en el sistema)/i.test(cleanReplyForClient);

        res.json({
            reply: cleanReplyForClient,
            sendPaymentImage: mentionsPayment,
            sendRegistrationImage: mentionsRegistration,
            ticketCreated: createdTicket,
            tickets: quotesService.getAllTickets()
        });
    } catch (error) {
        console.error('Error en /api/chat:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Inicializar cliente de WhatsApp real con Baileys
initWhatsAppClient(async (msg: any) => {
    try {
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.includes('@g.us') || remoteJid.includes('@newsletter')) {
            return;
        }

        let actualMessage = msg.message;
        if (actualMessage?.ephemeralMessage) {
            actualMessage = actualMessage.ephemeralMessage.message;
        } else if (actualMessage?.viewOnceMessageV2) {
            actualMessage = actualMessage.viewOnceMessageV2.message;
        }
        if (!actualMessage) return;

        const messageType = Object.keys(actualMessage)[0];
        let incomingMsg = '';

        if (messageType === 'conversation') {
            incomingMsg = actualMessage.conversation || '';
        } else if (messageType === 'extendedTextMessage') {
            incomingMsg = actualMessage.extendedTextMessage?.text || '';
        } else if (messageType === 'imageMessage') {
            incomingMsg = actualMessage.imageMessage?.caption || '';
        } else if (messageType === 'videoMessage') {
            incomingMsg = actualMessage.videoMessage?.caption || '';
        } else if (messageType === 'documentMessage') {
            incomingMsg = actualMessage.documentMessage?.caption || '';
        }

        const contextInfo =
            actualMessage?.extendedTextMessage?.contextInfo ||
            actualMessage?.imageMessage?.contextInfo ||
            actualMessage?.audioMessage?.contextInfo ||
            actualMessage?.videoMessage?.contextInfo ||
            actualMessage?.documentMessage?.contextInfo;
        const quotedStanzaId = contextInfo?.stanzaId || undefined;

        const senderAlt = (msg.key as any)?.remoteJidAlt || '';
        const rawPhone = senderAlt.includes('@s.whatsapp.net')
            ? senderAlt.split('@')[0]
            : remoteJid.split('@')[0];
        const from = rawPhone.split(':')[0];

        // 1. Detección de mensajes salientes (fromMe: true)
        if (msg.key.fromMe) {
            // Si el mensaje fue enviado por el propio bot automatizado, ignorar para no auto-pausarse
            if (msg.key.id && botMessageIds.has(msg.key.id)) {
                return;
            }

            // Si es un comando de ticket del coordinador (#123 ...) procesarlo
            const isTicketCommand = /^\s*#\d{3,4}\b/.test(incomingMsg);
            if (isTicketCommand) {
                await quotesService.handleCoordinatorMessage(from, incomingMsg, quotedStanzaId);
                return;
            }

            // Comandos manuales del asesor en el chat
            const cleanCmd = incomingMsg.toLowerCase().trim();
            if (cleanCmd === 'activar bot' || cleanCmd === '#bot' || cleanCmd === '#activar') {
                delete humanTakeover[remoteJid];
                console.log(`[REACTIVACIÓN MANUAL] Asesor reactivó el bot en el chat con +${from}.`);
                return;
            }
            if (cleanCmd === 'pausar bot' || cleanCmd === '#pausa' || cleanCmd === '#humano') {
                humanTakeover[remoteJid] = Date.now() + 15 * 60 * 1000; // 30 minutos de pausa
                console.log(`[PAUSA MANUAL] Asesor pausó el bot en el chat con +${from} por 30 minutos.`);
                return;
            }

            // Si un asesor humano de Médica Colombia respondió al paciente desde el celular o WhatsApp Web:
            if (incomingMsg.trim().length > 0) {
                humanTakeover[remoteJid] = Date.now();
                console.log(`[PAUSA AUTOMÁTICA] Asesor humano respondió en el chat con +${from}. Bot silenciado ${TAKEOVER_TIMEOUT_MS / 60000} minutos.`);
            }
            return;
        }

        // 2. Verificar si el chat con este paciente está pausado por atención humana
        if (humanTakeover[remoteJid]) {
            const elapsed = Date.now() - humanTakeover[remoteJid];
            const cleanText = incomingMsg.toLowerCase().trim();

            if (cleanText === 'activar bot' || cleanText === 'reiniciar bot' || cleanText === '#bot' || elapsed >= TAKEOVER_TIMEOUT_MS) {
                delete humanTakeover[remoteJid];
                console.log(`[BOT REACTIVADO] Pausa finalizada para +${from}. El bot vuelve a responder.`);
            } else {
                const remainingMinutes = Math.ceil((TAKEOVER_TIMEOUT_MS - elapsed) / 60000);
                console.log(`[SILENCIO HUMANO] Paciente +${from} escribió, pero el chat está en manos de un asesor humano (${remainingMinutes} mins restantes de pausa).`);
                return;
            }
        }

        const isCoordinatorSender = quotesService.isCoordinator(from, remoteJid, quotedStanzaId, incomingMsg);

        // Si el paciente o coordinador envía imagen o PDF (orden médica, historia clínica, comprobante de pago o cotización PDF)
        if (messageType === 'imageMessage' || messageType === 'documentMessage') {
            const isDoc = messageType === 'documentMessage';
            const docFilename = actualMessage?.documentMessage?.fileName || 'documento_medico.pdf';
            const mediaPath = await downloadWhatsAppMedia(msg);

            if (mediaPath) {
                if (isCoordinatorSender) {
                    const coordTicket = quotesService.findCoordinatorTicket(quotedStanzaId, incomingMsg);
                    if (coordTicket) {
                        await quotesService.forwardCoordinatorMediaToCustomer(coordTicket, mediaPath, isDoc, docFilename, incomingMsg);
                    }
                    try { fs.unlinkSync(mediaPath); } catch (e) {}
                    return;
                }

                let activeTicket = quotesService.getActiveCustomerTicket(remoteJid, from);
                if (!activeTicket) {
                    activeTicket = await quotesService.createTicket(
                        remoteJid,
                        from,
                        'Paciente (Envió Orden / Comprobante)',
                        'Validación de Orden Médica / Pago',
                        incomingMsg || 'Adjuntó archivo para revisión'
                    );
                }

                await quotesService.forwardCustomerMedia(activeTicket, mediaPath, isDoc, docFilename, incomingMsg);

                const replyMediaMsg = `Perfecto, ya recibí tu documento/imagen y se lo acabo de pasar a nuestro equipo de coordinación de Médica Colombia (Solicitud #${activeTicket.id}). En un momento te confirmo por aquí.`;
                await sendWhatsAppMessage(remoteJid, replyMediaMsg);
                try { fs.unlinkSync(mediaPath); } catch (e) {}
                return;
            }
        }

        // Si es nota de voz, transcribir con Whisper
        if (messageType === 'audioMessage') {
            const audioPath = await downloadWhatsAppMedia(msg);
            if (audioPath) {
                const transcription = await transcribeAudio(audioPath);
                incomingMsg = transcription
                    ? (isCoordinatorSender ? transcription : `[Nota de voz del paciente]: "${transcription}"`)
                    : '';
                try { fs.unlinkSync(audioPath); } catch (e) {}
            }
        }

        if (!incomingMsg) return;

        if (isCoordinatorSender) {
            console.log(`\n========================================`);
            console.log(`🩺 Mensaje detectado como Coordinación Médica Colombia (+${from})`);
            await quotesService.handleCoordinatorMessage(from, incomingMsg, quotedStanzaId);
            console.log(`========================================\n`);
            return;
        }

        // Deduplicación rápida de contenido idéntico en menos de 3.5 segundos
        const now = Date.now();
        const lastMsg = lastIncomingText[remoteJid];
        if (lastMsg && lastMsg.text === incomingMsg.trim() && (now - lastMsg.time) < 3500) {
            console.log(`[Deduplicación Contenido] Mensaje idéntico recibido en <3.5s de +${from}: omitiendo duplicado.`);
            return;
        }
        lastIncomingText[remoteJid] = { text: incomingMsg.trim(), time: now };

        // Buffer de agregación (debounce 2.2s) para unir mensajes consecutivos de un usuario
        const queueKey = remoteJid;
        if (userDebounceQueue[queueKey]) {
            clearTimeout(userDebounceQueue[queueKey].timer);
            userDebounceQueue[queueKey].messages.push(incomingMsg);
        } else {
            userDebounceQueue[queueKey] = {
                messages: [incomingMsg],
                timer: setTimeout(() => {}, 0)
            };
        }

        userDebounceQueue[queueKey].timer = setTimeout(async () => {
            const queue = userDebounceQueue[queueKey];
            delete userDebounceQueue[queueKey];
            if (!queue || queue.messages.length === 0) return;

            // Protección de concurrencia: si ya hay una respuesta generándose para este chat, esperar
            if (activeProcessingChats.has(remoteJid)) {
                console.log(`[Mutex] Ya hay una respuesta generándose para +${from}. Omitiendo solapamiento.`);
                return;
            }

            activeProcessingChats.add(remoteJid);
            try {
                const consolidatedMsg = queue.messages.join('\n').trim();
                await handleCustomerConsolidatedMessage(from, remoteJid, consolidatedMsg);
            } catch (err) {
                console.error(`Error en handleCustomerConsolidatedMessage (+${from}):`, err);
            } finally {
                activeProcessingChats.delete(remoteJid);
            }
        }, 2200);
    } catch (error) {
        console.error('Error procesando mensaje de WhatsApp:', error);
    }
});

async function handleCustomerConsolidatedMessage(from: string, remoteJid: string, incomingMsg: string) {
    try {
        console.log(`\n========================================`);
        console.log(`📩 Mensaje consolidado de WhatsApp (+${from}): "${incomingMsg}"`);

        const activeTicket = quotesService.getActiveCustomerTicket(remoteJid, from);
        let quoteContext: string | undefined = undefined;
        if (activeTicket) {
            quoteContext = activeTicket.status === 'PENDING'
                ? `Solicitud #${activeTicket.id} PENDIENTE en Coordinación para ${activeTicket.patientInfo} (${activeTicket.service}).`
                : `Solicitud #${activeTicket.id} YA CONFIRMADA para ${activeTicket.patientInfo} (${activeTicket.service}) -> Valor: ${activeTicket.quotePrice}.`;
        }

        const aiReply = await generateAIResponse(from, incomingMsg, quoteContext);

        const isHandoff = /\[ESCALAR_HUMANO:[^\]]+\]/i.test(aiReply);
        if (isHandoff) {
            humanTakeover[remoteJid] = Date.now();
            console.log(`[ESCALAR HUMANO] Paciente +${from} solicitó asesor humano. Bot pausado ${TAKEOVER_TIMEOUT_MS / 60000} minutos.`);
            const alertMsg = `⚠️ *SOLICITUD DE ASESOR HUMANO (Médica Colombia)*\nEl paciente +${from} solicitó hablar con un asesor.\nÚltimo mensaje del paciente: "${incomingMsg}"\nEl bot se ha silenciado automáticamente por ${TAKEOVER_TIMEOUT_MS / 60000} minutos en ese chat para que un asesor pueda atenderlo.`;
            await sendWhatsAppMessage(quotesService.coordinatorJid || quotesService.coordinatorPhone, alertMsg);
        }

        const quoteMatch = aiReply.match(/\[(?:SOLICITAR_COTIZACION|CONSULTAR_COORDINADOR):\s*([^\]]+)\]/i);
        const cleanReplyForClient = aiReply
            .replace(/\[(?:SOLICITAR_COTIZACION|CONSULTAR_COORDINADOR|ESCALAR_HUMANO):[^\]]+\]/gi, '')
            .replace(/\*/g, '')
            .trim();

        await sendWhatsAppMessage(remoteJid, cleanReplyForClient);

        // Solo adjuntar imagen de medios de pago si el cliente pregunta cómo pagar o si Coordinación ya confirmó la cotización/capacidad
        const clientAsksPayment = /(c[oó]mo pago|d[oó]nde pago|a d[oó]nde consigno|link de pago|medios de pago|n[uú]mero de cuenta|cuenta para pagar|datos para transferir)/i.test(incomingMsg);
        const coordinatorConfirmedPayment = (activeTicket?.status === 'QUOTED') && /(0091267532|073039034|bre-b|banco de occidente)/i.test(cleanReplyForClient);
        const mentionsPayment = clientAsksPayment || coordinatorConfirmedPayment;
        if (mentionsPayment) {
            const paymentImgPath = path.join(process.cwd(), 'public', 'medios_pago.jpg');
            if (fs.existsSync(paymentImgPath)) {
                await sendWhatsAppImage(remoteJid, paymentImgPath, 'Medios de Pago Oficiales - Médica Colombia S.A.S.');
            }
        }

        // Si se solicitan los datos de ingreso en el sistema, adjuntar la plantilla de datos del paciente
        const mentionsRegistration = /(estado civil|ocupaci[oó]n|parentesco|fecha de nacimiento|ingreso en el sistema)/i.test(cleanReplyForClient);
        if (mentionsRegistration) {
            const regImgPath = path.join(process.cwd(), 'public', 'datos_paciente.jpg');
            if (fs.existsSync(regImgPath)) {
                await sendWhatsAppImage(remoteJid, regImgPath, 'Datos requeridos para el ingreso en el sistema - Médica Colombia');
            }
        }

        if (quoteMatch) {
            const parts = quoteMatch[1].split('|').map(s => s.trim());
            const patientInfo = parts[0] || 'Paciente por confirmar';
            const service = parts[1] || 'Servicio Médica Colombia';
            const details = parts[2] || incomingMsg;

            await quotesService.createTicket(remoteJid, from, patientInfo, service, details);
        } else if (activeTicket && activeTicket.status === 'QUOTED') {
            await quotesService.forwardCustomerFollowup(activeTicket, incomingMsg);
        }

        console.log(`🤖 Respuesta de Diana (Médica Colombia): "${cleanReplyForClient}"`);
        console.log(`========================================\n`);
    } catch (error) {
        console.error('Error en handleCustomerConsolidatedMessage:', error);
    }
}

app.listen(port, () => {
    console.log(`🚀 Servidor de Médica Colombia Bot corriendo en http://localhost:${port}`);
});
