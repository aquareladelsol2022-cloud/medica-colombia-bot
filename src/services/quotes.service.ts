import fs from 'fs';
import path from 'path';
import { sendWhatsAppMessage, sendWhatsAppImage, sendWhatsAppDocument } from './whatsapp.service';
import { parseCoordinatorQuote, appendConversationMessage } from './ai.service';

export interface ServiceTicket {
    id: string; // "201", "202", ...
    customerJid: string;
    customerPhone: string;
    patientInfo: string;
    service: string;
    details: string;
    status: 'PENDING' | 'QUOTED' | 'CLOSED';
    coordinatorMessageId?: string;
    confirmMessageId?: string;
    quotePrice?: string;
    availability?: string | null;
    professional?: string | null;
    paymentLink?: string | null;
    quoteNotes?: string;
    attachmentReceived?: boolean;
    createdAt: number;
    updatedAt: number;
}

const quotesFilePath = path.join(process.cwd(), 'quotes.json');

class QuotesService {
    private tickets: Record<string, ServiceTicket> = {};
    private nextId: number = 201;
    public coordinatorPhone: string = process.env.COORDINATOR_PHONE || '573153658627';
    public ownerPhone: string = process.env.OWNER_PHONE || '573016593654';
    public coordinatorJid: string = '';

    constructor() {
        this.loadQuotes();
    }

    private loadQuotes() {
        try {
            if (fs.existsSync(quotesFilePath)) {
                const data = JSON.parse(fs.readFileSync(quotesFilePath, 'utf8'));
                this.tickets = data.tickets || {};
                this.nextId = data.nextId || 201;
                this.coordinatorJid = data.coordinatorJid || '';
            }
        } catch (err) {
            console.error('[QUOTES SERVICE] Error cargando quotes.json:', err);
            this.tickets = {};
            this.nextId = 201;
        }
    }

    private saveQuotes() {
        try {
            fs.writeFileSync(quotesFilePath, JSON.stringify({
                tickets: this.tickets,
                nextId: this.nextId,
                coordinatorJid: this.coordinatorJid
            }, null, 2), 'utf8');
        } catch (err) {
            console.error('[QUOTES SERVICE] Error guardando quotes.json:', err);
        }
    }

    public getAllTickets(): ServiceTicket[] {
        return Object.values(this.tickets).sort((a, b) => b.createdAt - a.createdAt);
    }

    public isCoordinator(
        phone: string,
        jid?: string,
        quotedStanzaId?: string,
        textMessage?: string
    ): boolean {
        const cleanPhone = phone.replace(/\D/g, '');
        const cleanCoordinator = this.coordinatorPhone.replace(/\D/g, '');

        if (cleanPhone && (cleanPhone === cleanCoordinator || cleanPhone.endsWith(cleanCoordinator.slice(-10)))) {
            if (jid) {
                this.coordinatorJid = jid;
                this.saveQuotes();
            }
            return true;
        }

        if (jid && this.coordinatorJid && jid === this.coordinatorJid) {
            return true;
        }

        if (quotedStanzaId) {
            const hasMatchedTicket = Object.values(this.tickets).some(
                t => t.coordinatorMessageId === quotedStanzaId || t.confirmMessageId === quotedStanzaId
            );
            if (hasMatchedTicket) {
                if (jid) {
                    this.coordinatorJid = jid;
                    this.saveQuotes();
                }
                return true;
            }
        }

        if (textMessage) {
            const match = textMessage.match(/(?:#|ticket\s*#?)\s*(\d{3,4})\b/i);
            if (match && this.tickets[match[1]]) {
                if (jid) {
                    this.coordinatorJid = jid;
                    this.saveQuotes();
                }
                return true;
            }
        }

        return false;
    }

    public async createTicket(
        customerJid: string,
        customerPhone: string,
        patientInfo: string,
        service: string,
        details: string = ''
    ): Promise<ServiceTicket> {
        const id = String(this.nextId++);
        const now = Date.now();

        const ticket: ServiceTicket = {
            id,
            customerJid,
            customerPhone,
            patientInfo: patientInfo || 'Paciente por confirmar',
            service: service || 'Servicio de salud / cuidado',
            details: details || 'Sin detalles adicionales',
            status: 'PENDING',
            createdAt: now,
            updatedAt: now
        };

        this.tickets[id] = ticket;
        this.saveQuotes();

        let displayPhone = ticket.customerPhone;
        if (displayPhone.length > 13) {
            displayPhone = 'Chat directo (WhatsApp)';
        } else {
            displayPhone = `+${displayPhone}`;
        }

        const coordMsg = `🩺 *NUEVA SOLICITUD MÉDICA COLOMBIA #${id}*\n\n` +
            `👤 *Paciente / Barrio:* ${ticket.patientInfo}\n` +
            `🏥 *Servicio solicitado:* ${ticket.service}\n` +
            `📋 *Detalles clínicos / Horario:* ${ticket.details}\n` +
            `📱 *WhatsApp Cliente:* ${displayPhone}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👉 *Para confirmar precio, profesional o agenda, responde citando este mensaje:*\n` +
            `🎤 *Nota de voz o Texto:* Ej: \`#${id} $220.000 mañana 8:30 am con Dra. Luisa Lasso\``;

        const targetCoord = this.coordinatorJid || this.coordinatorPhone;
        const sent = await sendWhatsAppMessage(targetCoord, coordMsg);
        if (sent?.key?.id) {
            ticket.coordinatorMessageId = sent.key.id;
            this.saveQuotes();
        }

        console.log(`[MÉDICA QUOTES] Solicitud #${id} creada para ${displayPhone}. Notificada a Coordinación (${targetCoord}).`);
        return ticket;
    }

    public findCoordinatorTicket(quotedStanzaId?: string, textMessage?: string): ServiceTicket | null {
        const cleanText = textMessage ? textMessage.trim() : '';

        if (quotedStanzaId) {
            const byQuote = Object.values(this.tickets).find(
                t => t.coordinatorMessageId === quotedStanzaId || t.confirmMessageId === quotedStanzaId
            );
            if (byQuote) return byQuote;
        }

        if (cleanText) {
            const match = cleanText.match(/(?:#|ticket\s*#?)\s*(\d{3,4})\b/i);
            if (match && this.tickets[match[1]]) {
                return this.tickets[match[1]];
            }
            const matchStart = cleanText.match(/^(\d{3,4})\b/);
            if (matchStart && this.tickets[matchStart[1]]) {
                return this.tickets[matchStart[1]];
            }
        }

        const pendingTickets = Object.values(this.tickets)
            .filter(t => t.status === 'PENDING')
            .sort((a, b) => b.updatedAt - a.updatedAt);

        if (pendingTickets.length === 1) {
            return pendingTickets[0];
        } else if (pendingTickets.length === 0) {
            const recentTickets = Object.values(this.tickets)
                .filter(t => (Date.now() - t.updatedAt < 3 * 60 * 60 * 1000))
                .sort((a, b) => b.updatedAt - a.updatedAt);

            if (recentTickets.length > 0) {
                return recentTickets[0];
            }
        }

        return null;
    }

    public async handleCoordinatorMessage(
        from: string,
        textMessage: string,
        quotedStanzaId?: string
    ): Promise<boolean> {
        const cleanText = textMessage.trim();
        const matchedTicket = this.findCoordinatorTicket(quotedStanzaId, textMessage);

        if (!matchedTicket) {
            const activeList = Object.values(this.tickets)
                .filter(t => t.status === 'PENDING')
                .map(t => `• *#${t.id}:* ${t.patientInfo} - ${t.service}`)
                .join('\n');

            const helpMsg = `⚠️ *No pude identificar el número de solicitud.*\n\n` +
                (activeList
                    ? `Actualmente tienes estas solicitudes pendientes:\n${activeList}\n\n👉 Responde deslizando el mensaje de la solicitud o escribiendo: \`#NUMERO [Valor / Agenda / Profesional]\``
                    : `No tienes solicitudes pendientes en este momento.`);

            await sendWhatsAppMessage(this.coordinatorJid || this.coordinatorPhone, helpMsg);
            return true;
        }

        let cleanQuote = cleanText
            .replace(new RegExp(`#?${matchedTicket.id}\\b`, 'gi'), '')
            .replace(/^[:\-,\s]+/, '')
            .trim();

        const isCorrection = cleanQuote.toLowerCase().startsWith('corregir') ||
            cleanText.toLowerCase().startsWith('rectifico') ||
            matchedTicket.status === 'QUOTED';

        if (isCorrection) {
            cleanQuote = cleanQuote
                .replace(/^(corregir|rectifico)\s*/i, '')
                .trim();
        }

        if (!cleanQuote) {
            await sendWhatsAppMessage(
                this.coordinatorJid || this.coordinatorPhone,
                `⚠️ Por favor indica el valor, profesional o disponibilidad para la solicitud #${matchedTicket.id}.`
            );
            return true;
        }

        let quotePrice = cleanQuote;
        let quoteAvailability: string | null = null;
        let quoteProfessional: string | null = null;
        let quotePaymentLink: string | null = null;
        let quoteNotes: string | null = null;

        const aiParsed = await parseCoordinatorQuote(cleanQuote);
        if (aiParsed) {
            quotePrice = (aiParsed.price || cleanQuote).replace(/\*/g, '').trim();
            quoteAvailability = aiParsed.availability ? aiParsed.availability.replace(/\*/g, '').trim() : null;
            quoteProfessional = aiParsed.professional ? aiParsed.professional.replace(/\*/g, '').trim() : null;
            quotePaymentLink = aiParsed.paymentLink ? aiParsed.paymentLink.trim() : null;
            quoteNotes = aiParsed.notes ? aiParsed.notes.replace(/\*/g, '').trim() : null;
        }

        matchedTicket.quotePrice = quotePrice;
        if (quoteAvailability) matchedTicket.availability = quoteAvailability;
        if (quoteProfessional) matchedTicket.professional = quoteProfessional;
        if (quotePaymentLink) matchedTicket.paymentLink = quotePaymentLink;
        if (quoteNotes) matchedTicket.quoteNotes = quoteNotes;
        matchedTicket.status = 'QUOTED';
        matchedTicket.updatedAt = Date.now();
        this.saveQuotes();

        let clientMsg = `Hola, te habla Diana Rodríguez de Médica Colombia. Ya validé tu solicitud para ${matchedTicket.patientInfo}:\n\n` +
            `🩺 Servicio: ${matchedTicket.service}\n` +
            `💵 Valor: ${matchedTicket.quotePrice}\n` +
            (matchedTicket.professional ? `👩‍⚕️ Profesional asignado: ${matchedTicket.professional}\n` : '') +
            (matchedTicket.availability ? `📅 Disponibilidad / Horario: ${matchedTicket.availability}\n` : '') +
            (matchedTicket.quoteNotes ? `📋 Nota importante: ${matchedTicket.quoteNotes}\n` : '') +
            (matchedTicket.paymentLink ? `\n💳 Link de pago en línea: ${matchedTicket.paymentLink}\n` : '') +
            `\nRecuerda que también puedes realizar el pago por nuestra Llave Bre-B 0091267532 o en Efecty / Banco de Occidente Cuenta Corriente 073039034 (Medicina Integral en Casa Colombia SAS - NIT 900169638). ¿Confirmamos tu programación?`;

        const targetCustomer = matchedTicket.customerJid || `${matchedTicket.customerPhone}@s.whatsapp.net`;
        await sendWhatsAppMessage(targetCustomer, clientMsg);

        // Enviar también la imagen oficial de Medios de Pago de Médica Colombia
        const paymentImgPath = path.join(process.cwd(), 'public', 'medios_pago.jpg');
        if (fs.existsSync(paymentImgPath)) {
            await sendWhatsAppImage(targetCustomer, paymentImgPath, 'Medios de Pago Oficiales - Médica Colombia S.A.S. (Llave Bre-B: 0091267532 | Banco de Occidente: 073039034)');
        }

        if (matchedTicket.customerPhone) {
            appendConversationMessage(matchedTicket.customerPhone, 'assistant', clientMsg);
        }
        if (matchedTicket.customerJid && matchedTicket.customerJid !== matchedTicket.customerPhone) {
            appendConversationMessage(matchedTicket.customerJid, 'assistant', clientMsg);
        }

        let customerDisplay = matchedTicket.customerPhone;
        if (customerDisplay.length > 13) customerDisplay = 'Chat de WhatsApp';
        else customerDisplay = `+${customerDisplay}`;

        const confirmMsg = `✅ *Respuesta #${matchedTicket.id} enviada al paciente (${customerDisplay}).*\n\n` +
            `👤 *Paciente:* ${matchedTicket.patientInfo}\n` +
            `🏥 *Servicio:* ${matchedTicket.service}\n` +
            `💵 *Valor informado:* ${matchedTicket.quotePrice}\n` +
            (matchedTicket.professional ? `👩‍⚕️ *Profesional:* ${matchedTicket.professional}\n` : '') +
            (matchedTicket.availability ? `📅 *Horario:* ${matchedTicket.availability}\n` : '');

        const sentConfirm = await sendWhatsAppMessage(this.coordinatorJid || this.coordinatorPhone, confirmMsg);
        if (sentConfirm?.key?.id) {
            matchedTicket.confirmMessageId = sentConfirm.key.id;
            this.saveQuotes();
        }

        return true;
    }

    public getActiveCustomerTicket(customerJid?: string, customerPhone?: string): ServiceTicket | null {
        const now = Date.now();
        const cleanPhone = customerPhone ? customerPhone.replace(/\D/g, '') : '';
        const customerTickets = Object.values(this.tickets)
            .filter(t => {
                const matchJid = customerJid && t.customerJid === customerJid;
                const matchPhone = cleanPhone && (t.customerPhone === cleanPhone || t.customerPhone.endsWith(cleanPhone.slice(-10)));
                const isRecent = (now - t.createdAt < 48 * 60 * 60 * 1000);
                return (matchJid || matchPhone) && isRecent && t.status !== 'CLOSED';
            })
            .sort((a, b) => b.createdAt - a.createdAt);

        return customerTickets[0] || null;
    }

    public closeTicket(ticketId: string, reason?: string): boolean {
        if (this.tickets[ticketId]) {
            this.tickets[ticketId].status = 'CLOSED';
            this.tickets[ticketId].updatedAt = Date.now();
            this.saveQuotes();
            console.log(`[MÉDICA QUOTES] Solicitud #${ticketId} cerrada. Motivo: ${reason || 'N/A'}`);
            return true;
        }
        return false;
    }

    public async forwardCustomerFollowup(ticket: ServiceTicket, followupText: string) {
        const cleanFollowup = followupText.trim().toLowerCase();
        const isCourtesy = /^(gracias|muchas gracias|mil gracias|ok|vale|listo|dale|perfecto|excelente|bien|bueno|de una|está bien|hola|buenos días|buenas tardes|buenas noches)[\s!.,]*$/i.test(cleanFollowup);
        if (isCourtesy) return;

        const updateMsg = `🔔 *MENSAJE ADICIONAL DEL PACIENTE - SOLICITUD #${ticket.id}*\n\n` +
            `👤 *Paciente:* ${ticket.patientInfo}\n` +
            `🏥 *Servicio:* ${ticket.service}\n` +
            `💬 *El paciente escribe:* "${followupText}"\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👉 *Responde citando este mensaje o con:*\n` +
            `*#${ticket.id} [Respuesta / Confirmación]*`;

        const sent = await sendWhatsAppMessage(this.coordinatorJid || this.coordinatorPhone, updateMsg);
        if (sent?.key?.id) {
            ticket.coordinatorMessageId = sent.key.id;
            ticket.updatedAt = Date.now();
            this.saveQuotes();
        }
    }

    public async forwardCustomerMedia(
        ticket: ServiceTicket,
        mediaPath: string,
        isDocument: boolean = false,
        filename: string = 'documento.pdf',
        customerComment: string = ''
    ): Promise<boolean> {
        let displayPhone = ticket.customerPhone;
        if (displayPhone.length > 13) displayPhone = 'Chat de WhatsApp';
        else displayPhone = `+${displayPhone}`;

        const caption = `📎 *ORDEN MÉDICA / HISTORIA / COMPROBANTE - SOLICITUD #${ticket.id}*\n\n` +
            `👤 *Paciente:* ${ticket.patientInfo}\n` +
            `🏥 *Servicio:* ${ticket.service}\n` +
            `📱 *Cliente:* ${displayPhone}\n` +
            (customerComment ? `💬 *Comentario:* "${customerComment}"\n` : '') +
            `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `👉 *Para responder al paciente, desliza este archivo con audio o texto: \`#${ticket.id} [Valor / Confirmación]\`*`;

        const targetCoord = this.coordinatorJid || this.coordinatorPhone;
        let sent: any = null;
        if (isDocument) {
            sent = await sendWhatsAppDocument(targetCoord, mediaPath, filename, caption);
        } else {
            sent = await sendWhatsAppImage(targetCoord, mediaPath, caption);
        }

        ticket.attachmentReceived = true;
        if (sent?.key?.id) {
            ticket.coordinatorMessageId = sent.key.id;
        }
        ticket.updatedAt = Date.now();
        this.saveQuotes();
        return true;
    }

    public async forwardCoordinatorMediaToCustomer(
        ticket: ServiceTicket,
        mediaPath: string,
        isDocument: boolean = false,
        filename: string = 'Cotizacion_Medica_Colombia.pdf',
        coordinatorCaption: string = ''
    ): Promise<boolean> {
        const targetCustomer = ticket.customerJid || `${ticket.customerPhone}@s.whatsapp.net`;
        const clientCaption = `Hola, te habla Diana Rodríguez de Médica Colombia. Te comparto el documento respecto a tu solicitud (${ticket.service}):\n\n` +
            (coordinatorCaption ? `📋 ${coordinatorCaption}\n\n` : '') +
            `Quedo muy atenta para confirmar tu programación.`;

        if (isDocument) {
            await sendWhatsAppDocument(targetCustomer, mediaPath, filename, clientCaption);
        } else {
            await sendWhatsAppImage(targetCustomer, mediaPath, clientCaption);
        }

        appendConversationMessage(ticket.customerPhone, 'assistant', clientCaption);
        return true;
    }
}

export const quotesService = new QuotesService();
