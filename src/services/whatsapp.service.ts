import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import fs from 'fs';
import path from 'path';
import os from 'os';
import pino from 'pino';

export let sock: any = null;
export let latestQrUrl: string | null = null;
export let isWhatsAppConnected: boolean = false;
let qrPrintedOnce = false;

export const initWhatsAppClient = async (onMessageReceived: (msg: any) => Promise<void>) => {
    const authDir = path.join(process.cwd(), 'baileys_auth_info');
    if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
    }
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }) as any,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: false,
        markOnlineOnConnect: false
    });

    sock.ev.on('connection.update', (update: any) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=' + encodeURIComponent(qr);
            if (!qrPrintedOnce) {
                qrPrintedOnce = true;
                console.log('\n=========================================');
                console.log('🩺 ESCANEA ESTE CÓDIGO QR PARA MÉDICA COLOMBIA:');
                qrcode.generate(qr, { small: true });
                console.log('\nEnlace QR en vivo: http://localhost:3085/api/qr');
                console.log('=========================================\n');
            }
        }

        if (connection === 'close') {
            isWhatsAppConnected = false;
            const shouldReconnect = (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(() => initWhatsAppClient(onMessageReceived), 3000);
            } else {
                console.log('[Baileys] La sesión fue cerrada desde el celular. Limpiando credenciales y generando nuevo QR...');
                try {
                    if (fs.existsSync(authDir)) {
                        fs.rmSync(authDir, { recursive: true, force: true });
                    }
                } catch (e) {
                    console.error('Error borrando llaves:', e);
                }
                qrPrintedOnce = false;
                setTimeout(() => initWhatsAppClient(onMessageReceived), 2000);
            }
        } else if (connection === 'open') {
            isWhatsAppConnected = true;
            latestQrUrl = null;
            console.log('✅ ¡Cliente de WhatsApp Web conectado y listo para Médica Colombia S.A.S.! (Baileys)');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m: any) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (msg.message) {
                    await onMessageReceived(msg);
                }
            }
        }
    });
};

export const sendWhatsAppMessage = async (to: string, body: string): Promise<any> => {
    try {
        if (!sock) {
            console.log(`[WhatsApp Simulación a ${to}]:\n${body}`);
            return null;
        }

        let chatId = to;
        if (to.includes('@c.us')) chatId = to.replace('@c.us', '@s.whatsapp.net');
        else if (!to.includes('@')) chatId = `${to.replace(/\D/g, '')}@s.whatsapp.net`;

        const sent = await sock.sendMessage(chatId, { text: body });
        console.log(`[Baileys] Mensaje enviado a ${chatId}`);
        return sent;
    } catch (error: any) {
        console.error(`[Baileys] Error al enviar a ${to}:`, error);
        return null;
    }
};

export const sendWhatsAppImage = async (to: string, filePath: string, caption?: string): Promise<any> => {
    try {
        if (!sock) {
            console.log(`[WhatsApp Simulación Imagen a ${to}]: ${caption || ''}`);
            return null;
        }
        let chatId = to;
        if (to.includes('@c.us')) chatId = to.replace('@c.us', '@s.whatsapp.net');
        else if (!to.includes('@')) chatId = `${to.replace(/\D/g, '')}@s.whatsapp.net`;

        const payload: any = { image: fs.readFileSync(filePath) };
        if (caption) payload.caption = caption;

        const sent = await sock.sendMessage(chatId, payload);
        console.log(`[Baileys] Imagen enviada a ${chatId}`);
        return sent;
    } catch (error: any) {
        console.error(`[Baileys] Error enviando imagen a ${to}:`, error);
        return null;
    }
};

export const sendWhatsAppDocument = async (to: string, filePath: string, filename: string, caption?: string): Promise<any> => {
    try {
        if (!sock) {
            console.log(`[WhatsApp Simulación Documento a ${to}]: ${filename}`);
            return null;
        }
        let chatId = to;
        if (to.includes('@c.us')) chatId = to.replace('@c.us', '@s.whatsapp.net');
        else if (!to.includes('@')) chatId = `${to.replace(/\D/g, '')}@s.whatsapp.net`;

        const payload: any = { document: fs.readFileSync(filePath), mimetype: 'application/pdf', fileName: filename };
        if (caption) payload.caption = caption;

        const sent = await sock.sendMessage(chatId, payload);
        console.log(`[Baileys] Documento enviado a ${chatId}`);
        return sent;
    } catch (error: any) {
        console.error(`[Baileys] Error enviando documento a ${to}:`, error);
        return null;
    }
};

export const downloadWhatsAppMedia = async (msg: any): Promise<string | null> => {
    try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {});
        if (!buffer) return null;

        let actualMsg = msg.message;
        if (actualMsg?.ephemeralMessage) actualMsg = actualMsg.ephemeralMessage.message;
        else if (actualMsg?.viewOnceMessageV2) actualMsg = actualMsg.viewOnceMessageV2.message;

        let extension = 'bin';
        const messageType = Object.keys(actualMsg || {})[0];

        if (messageType === 'audioMessage') extension = 'ogg';
        else if (messageType === 'videoMessage') extension = 'mp4';
        else if (messageType === 'imageMessage') extension = 'jpg';
        else if (messageType === 'documentMessage') extension = 'pdf';

        const mediaDir = path.join(process.cwd(), 'temp_media');
        if (!fs.existsSync(mediaDir)) {
            fs.mkdirSync(mediaDir, { recursive: true });
        }
        const tempFilePath = path.join(mediaDir, `medica_media_${Date.now()}.${extension}`);
        fs.writeFileSync(tempFilePath, buffer);
        return tempFilePath;
    } catch (error: any) {
        console.error('[Baileys] Error downloading media:', error);
        return null;
    }
};
