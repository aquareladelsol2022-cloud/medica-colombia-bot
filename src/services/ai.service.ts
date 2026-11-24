import OpenAI from 'openai';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

const conversations: Record<string, ChatMessage[]> = {};

export const appendConversationMessage = (
    userPhone: string,
    role: 'user' | 'assistant' | 'system',
    content: string
) => {
    if (!userPhone || !content) return;
    const cleanKey = userPhone.replace('@s.whatsapp.net', '').replace('@c.us', '');
    for (const key of [userPhone, cleanKey]) {
        if (!conversations[key]) {
            conversations[key] = [];
        }
        conversations[key].push({ role, content });
        if (conversations[key].length > 16) {
            conversations[key] = conversations[key].slice(conversations[key].length - 16);
        }
    }
};

export const resetConversation = (userPhone: string) => {
    const cleanKey = userPhone.replace('@s.whatsapp.net', '').replace('@c.us', '');
    delete conversations[userPhone];
    delete conversations[cleanKey];
};

const getKnowledgeBase = (): string => {
    try {
        const kbPath = path.join(process.cwd(), 'knowledge_base.md');
        if (fs.existsSync(kbPath)) {
            return fs.readFileSync(kbPath, 'utf8');
        }
        return 'Información de la empresa no disponible.';
    } catch (error) {
        console.error('Error leyendo knowledge_base.md:', error);
        return '';
    }
};

export const generateAIResponse = async (userPhone: string, userMessage: string, quoteContext?: string): Promise<string> => {
    try {
        if (!process.env.OPENAI_API_KEY) {
            return 'Hola, soy Diana Rodríguez de Médica Colombia. En este momento estoy validando tu solicitud, ¿en qué servicio te puedo colaborar?';
        }

        const knowledgeBase = getKnowledgeBase();

        const systemPrompt = `Eres Diana Rodríguez, coordinadora de atención al usuario y agendamiento de Médica Colombia S.A.S. (Medicina Integral en Casa Colombia S.A.S.) con cobertura en Cali, Jamundí (incluyendo Potrerito), Santander de Quilichao, Puerto Tejada, Candelaria, Villagorgona, Palmira, El Cerrito, Yumbo y municipios aledaños. Atiendes a los pacientes y familias por WhatsApp.

REGLAS ESTRICTAS DE COMPORTAMIENTO (OBLIGATORIAS):
1. NUNCA DIGAS QUE ERES UN BOT O IA: Eres Diana Rodríguez, una persona real del equipo de Médica Colombia.
2. RESPUESTAS CORTAS Y CONCISAS (1 A 3 ORACIONES MÁXIMO): No envíes listas largas a menos que el paciente pida comparar varias opciones. En WhatsApp la gente lee rápido.
3. PROHIBIDO USAR ASTERISCOS (*): NUNCA uses asteriscos (*) en tus mensajes. Escribe en texto plano natural.
4. CERO TARJETAS MÉDICAS O MEMBRESÍAS: Nuestro modelo es de atención directa y sin intermediarios (el paciente paga únicamente por el servicio que necesita).
5. COBERTURA GEOGRÁFICA OFICIAL (PROHIBIDO DECIR QUE NO CUBRIMOS JAMUNDÍ):
   - Médica Colombia tiene cobertura domiciliaria en: Todo Cali, Jamundí (incluyendo Potrerito Jamundí, Alfaguara, etc.), Santander de Quilichao, Puerto Tejada, Candelaria, Villagorgona, Palmira, El Cerrito, Yumbo y sectores aledaños del Valle del Cauca y Norte del Cauca.
   - NUNCA digas que no cubrimos Jamundí ni los municipios mencionados. Si preguntan si atendemos allá o fuera de Cali, di SIEMPRE que sí tenemos cobertura y solicita la dirección, barrio y servicio para coordinar la disponibilidad con el equipo.
6. PROTOCOLO OBLIGATORIO DE INYECTOLOGÍA Y PROCEDIMIENTOS DOMICILIARIOS (PROHIBIDO PEDIR PAGO DE ENTRADA):
   - Cuando el paciente solicite inyectología ($35.000 intramuscular/subcutánea a domicilio), medicamentos endovenosos, curaciones, cambio de sonda o procedimientos de enfermería:
     a) Solicita primero foto de la fórmula u orden médica para validar qué medicamento es y confirmar que sea apto para manejo domiciliario.
     b) Solicita la dirección, barrio y municipio para que Coordinación verifique que haya cobertura y capacidad instalada (personal de enfermería disponible en la zona y horario).
     c) Genera la etiqueta [SOLICITAR_COTIZACION: Paciente | Inyectología/Procedimiento | Medicamento, Dirección, Barrio, Orden médica].
     d) PROHIBIDO PEDIR PAGO DE ENTRADA: El pago y los datos de ingreso en el sistema se solicitan ÚNICAMENTE DESPUÉS de que Coordinación confirme que la orden es apta para casa y que hay capacidad instalada.
7. AGENDAMIENTO, DATOS DE INGRESO Y MEDIOS DE PAGO:
   - Cuando el paciente confirme agendamiento o cotización, incluye al final la etiqueta:
     [SOLICITAR_COTIZACION: Nombre o Paciente | Servicio y Modalidad | Barrio, condición y horario deseado]
   - Solo informa cuentas bancarias o Llave Bre-B cuando el paciente pregunte expresamente cómo pagar o cuando Coordinación ya haya confirmado la capacidad instalada para el servicio.
8. ATENCIÓN HUMANA Y ESCALAMIENTO:
   - Si el paciente pide expresamente hablar con un asesor humano o doctor ("quiero hablar con un asesor", "comunícame con un humano", "quiero hablar con alguien"), infórmale amablemente que con gusto le transfieres la conversación a uno de nuestros asesores para que lo atienda personalmente, e incluye al final la etiqueta [ESCALAR_HUMANO: Paciente solicita asesor humano].
9. EMPLEO, VACANTES Y HOJAS DE VIDA:
   - Si la persona escribe preguntando por trabajo, vacantes, empleo o cómo enviar su hoja de vida (médicos, enfermeros, auxiliares, terapeutas o administrativos), dile con gusto que las postulaciones las gestiona directamente el área de Talento Humano y que pueden enviar su hoja de vida en PDF al correo oficial: asistalentohumano@medicacolombia.com indicando en el asunto el cargo al que aspiran. NUNCA des el correo de servicio al cliente para temas de empleo.

INFORMACIÓN OFICIAL DE MÉDICA COLOMBIA S.A.S. (TARIFAS 2026 Y PROTOCOLOS):
${knowledgeBase}
${quoteContext ? `\nESTADO ACTUAL DE SOLICITUDES / COTIZACIONES ACTIVAS DE ESTE PACIENTE:\n${quoteContext}\n` : ''}`;

        if (!conversations[userPhone]) {
            conversations[userPhone] = [];
        }

        conversations[userPhone].push({ role: 'user', content: userMessage });

        if (conversations[userPhone].length > 14) {
            conversations[userPhone] = conversations[userPhone].slice(conversations[userPhone].length - 14);
        }

        const messagesToSend: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...conversations[userPhone]
        ];

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: messagesToSend,
            max_tokens: 280,
            temperature: 0.35
        });

        let botReply = response.choices[0]?.message?.content?.trim() || 'Disculpa, ¿me podrías confirmar qué servicio necesitas para ayudarte de inmediato?';

        // Preservar la etiqueta [SOLICITAR_COTIZACION: ...] o [ESCALAR_HUMANO: ...] si existe, y quitar asteriscos del resto del mensaje
        const tagMatch = botReply.match(/\[(?:SOLICITAR_COTIZACION|CONSULTAR_COORDINADOR|ESCALAR_HUMANO):[^\]]+\]/i);
        const cleanBody = botReply
            .replace(/\[(?:SOLICITAR_COTIZACION|CONSULTAR_COORDINADOR|ESCALAR_HUMANO):[^\]]+\]/gi, '')
            .replace(/\*/g, '')
            .trim();

        const finalReply = tagMatch ? `${cleanBody} ${tagMatch[0]}` : cleanBody;

        conversations[userPhone].push({ role: 'assistant', content: cleanBody });

        return finalReply;
    } catch (error) {
        console.error('[OpenAI Error]:', error);
        return 'Permíteme un momento por favor mientras valido la disponibilidad en el sistema.';
    }
};

export const transcribeAudio = async (filePath: string): Promise<string> => {
    try {
        if (!process.env.OPENAI_API_KEY) {
            return '';
        }
        const transcription = await openai.audio.transcriptions.create({
            file: fs.createReadStream(filePath),
            model: 'whisper-1',
            language: 'es'
        });
        console.log(`[Whisper] Audio transcrito: "${transcription.text}"`);
        return transcription.text;
    } catch (error) {
        console.error('[Whisper Error]:', error);
        return '';
    }
};

export interface ParsedCoordinatorQuote {
    price: string;
    availability: string | null;
    professional: string | null;
    paymentLink: string | null;
    notes: string | null;
}

export const parseCoordinatorQuote = async (rawText: string): Promise<ParsedCoordinatorQuote | null> => {
    try {
        if (!process.env.OPENAI_API_KEY) return null;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            response_format: { type: 'json_object' },
            messages: [
                {
                    role: 'system',
                    content: `Eres el asistente administrativo de Médica Colombia S.A.S. El coordinador operativo (Diana, Jefe Olga o el profesional) acaba de responder por texto o nota de voz sobre una cotización o agendamiento de un paciente.
Extrae la información en un objeto JSON con estas 5 claves:
1. "price": El valor o tarifa confirmada con signo de pesos y puntos de mil (ej: "$220.000", "$58.000 por sesión", o "Tarifa confirmada").
2. "availability": Horario o fecha confirmada para la cita/visita (ej: "Mañana a las 8:30 a.m.", "Hoy a las 6:30 p.m.", o null si no menciona horario).
3. "professional": Nombre del médico, fisioterapeuta, enfermera o profesional asignado si lo menciona (ej: "Dra. Luisa Lasso", "Fisioterapeuta Catalina García", "Auxiliar Carlos Sevillano", o null).
4. "paymentLink": Si el coordinador incluyó un link de pago (ej. https://checkout.bold.co/... o https://checkout.rapyd.net/...), extráelo aquí, o null.
5. "notes": Cualquier recomendación clínica o instrucción adicional (ej: "Estar en ayunas a las 6:00 a.m.", "Incluye auxiliar fija y turnera", o null).
PROHIBIDO USAR ASTERISCOS (*).`
                },
                {
                    role: 'user',
                    content: rawText
                }
            ],
            max_tokens: 220,
            temperature: 0.1
        });

        const content = response.choices[0]?.message?.content?.trim();
        if (!content) return null;
        return JSON.parse(content) as ParsedCoordinatorQuote;
    } catch (error) {
        console.error('[OpenAI Parse Coordinator Quote Error]:', error);
        return null;
    }
};
