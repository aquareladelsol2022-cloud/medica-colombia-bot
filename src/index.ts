import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { initWhatsAppClient, sendWhatsAppMessage, sendWhatsAppImage, downloadWhatsAppMedia, latestQrUrl, isWhatsAppConnected } from './services/whatsapp.service';
import { generateAIResponse, transcribeAudio, resetConversation } from './services/ai.service';
import { quotesService } from './services/quotes.service';

dotenv.config();

const app = express();
const port = process.env.PORT || 3085;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(process.cwd(), 'public')));

app.get('/status', (req: Request, res: Response) => {
    res.send('🩺 Bot de Médica Colombia S.A.S. (Salud, Cuidado y Hogar) está ACTIVO.');
});

app.get('/api/qr', (req: Request, res: Response) => {
    if (isWhatsAppConnected) {
        res.send('<html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0b141a;color:#e9edef;"><h2>✅ WhatsApp ya está conectado con Médica Colombia S.A.S.</h2></body></html>');
        return;
    }
    if (!latestQrUrl) {
        res.send('<html><head><meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0b141a;color:#e9edef;"><h2>⏳ Generando código QR de WhatsApp... (se actualiza solo)</h2></body></html>');
        return;
    }
    res.send(`<html><head><meta http-equiv="refresh" content="15"></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0b141a;color:#e9edef;"><h2>🩺 Escanea este Código QR con WhatsApp (Médica Colombia S.A.S.)</h2><p style="color:#8696a0;">Se actualiza automáticamente cada 15 segundos</p><img src="${latestQrUrl}" style="border-radius:16px;border:8px solid white;margin-top:12px;" width="340" height="340"/></body></html>`);
});

app.get('/api/tickets', (req: Request, res: Response) => {
    res.json({ tickets: quotesService.getAllTickets(), whatsappConnected: isWhatsAppConnected, qrUrl: latestQrUrl });
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
            .replace(/\[(?:SOLICITAR_COTIZACION|CONSULTAR_COORDINADOR):[^\]]+\]/gi, '')
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

        // Detectar si en la conversación se habló de medios de pago o datos de ingreso para adjuntar la imagen oficial
        const mentionsPayment = /(0091267532|073039034|bre-b|medios de pago|efecty|banco de occidente|cómo pago|como pago|donde pago|transferencia|consignaci)/i.test(cleanReplyForClient + ' ' + message);
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

        if (msg.key.fromMe) {
            const isTicketCommand = /^\s*#\d{3,4}\b/.test(incomingMsg);
            if (!isTicketCommand) return;
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

        console.log(`\n========================================`);
        console.log(`📩 Mensaje de WhatsApp (+${from}): "${incomingMsg}"`);

        if (isCoordinatorSender) {
            console.log(`🩺 Mensaje detectado como Coordinación Médica Colombia (+${from})`);
            await quotesService.handleCoordinatorMessage(from, incomingMsg, quotedStanzaId);
            console.log(`========================================\n`);
            return;
        }

        const activeTicket = quotesService.getActiveCustomerTicket(remoteJid, from);
        let quoteContext: string | undefined = undefined;
        if (activeTicket) {
            quoteContext = activeTicket.status === 'PENDING'
                ? `Solicitud #${activeTicket.id} PENDIENTE en Coordinación para ${activeTicket.patientInfo} (${activeTicket.service}).`
                : `Solicitud #${activeTicket.id} YA CONFIRMADA para ${activeTicket.patientInfo} (${activeTicket.service}) -> Valor: ${activeTicket.quotePrice}.`;
        }

        const aiReply = await generateAIResponse(from, incomingMsg, quoteContext);

        const quoteMatch = aiReply.match(/\[(?:SOLICITAR_COTIZACION|CONSULTAR_COORDINADOR):\s*([^\]]+)\]/i);
        const cleanReplyForClient = aiReply
            .replace(/\[(?:SOLICITAR_COTIZACION|CONSULTAR_COORDINADOR):[^\]]+\]/gi, '')
            .replace(/\*/g, '')
            .trim();

        await sendWhatsAppMessage(remoteJid, cleanReplyForClient);

        // Si se mencionan los medios de pago o el cliente pregunta cómo pagar, adjuntar la imagen oficial de Medios de Pago
        const mentionsPayment = /(0091267532|073039034|bre-b|medios de pago|efecty|banco de occidente|cómo pago|como pago|donde pago|transferencia|consignaci)/i.test(cleanReplyForClient + ' ' + incomingMsg);
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
        console.error('Error procesando mensaje de WhatsApp:', error);
    }
});

app.listen(port, () => {
    console.log(`🚀 Servidor de Médica Colombia Bot corriendo en http://localhost:${port}`);
});
