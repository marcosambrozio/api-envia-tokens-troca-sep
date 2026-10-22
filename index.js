const config = require('./config.json');
const fs = require('fs');
const dns = require('dns');
const moment = require("moment");
const express = require('express');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    Browsers 
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.json());

// --- MIDDLEWARE DE AUTENTICAÇÃO WEB ---
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        res.setHeader('WWW-Authenticate', 'Basic realm="SEP - Acesso Restrito"');
        return res.status(401).send('Autenticação necessária para acessar o SEP.');
    }

    const auth = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
    const user = auth[0];
    const pass = auth[1];

    if (user === config.webUser && pass === config.webPassword) {
        next();
    } else {
        res.setHeader('WWW-Authenticate', 'Basic realm="SEP - Acesso Restrito"');
        return res.status(401).send('Credenciais inválidas.');
    }
};

var sock;
var qrCodeDinamico = null;
const logHistory = [];
const maxLogs = 300;

// --- SISTEMA DE LOGS FILTRADO ---
const originalConsoleLog = console.log;
console.log = function (...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    
    const isQrLog = msg.includes('\u2588') || msg.includes('▄') || msg.includes('▀');
    
    if (!isQrLog) {
        logHistory.push(`[${moment().format('HH:mm:ss')}] ${msg}`);
        if (logHistory.length > maxLogs) logHistory.shift();
    }
    
    originalConsoleLog.apply(console, args);
};

// --- FORMATAÇÃO DE JID BÁSICA ---
const formatToJid = (number) => {
    let cleanNumber = number.toString().replace(/\D/g, '');
    return cleanNumber.includes('@s.whatsapp.net') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
}

// --- VALIDAÇÃO INTELIGENTE (9º DÍGITO) ---
async function validarNumeroWhatsapp(jid) {
    const [result] = await sock.onWhatsApp(jid);
    if (result && result.exists) {
        return result.jid;
    }

    let apenasNumeros = jid.replace('@s.whatsapp.net', '');

    if (apenasNumeros.startsWith('55') && apenasNumeros.length >= 12) {
        const ddd = apenasNumeros.substring(2, 4);
        const numero = apenasNumeros.substring(4);
        let tentativa2 = '';

        if (numero.length === 8) {
            tentativa2 = '55' + ddd + '9' + numero + '@s.whatsapp.net';
        } else if (numero.length === 9 && numero.startsWith('9')) {
            tentativa2 = '55' + ddd + numero.substring(1) + '@s.whatsapp.net';
        }

        if (tentativa2 !== '') {
            const [result2] = await sock.onWhatsApp(tentativa2);
            if (result2 && result2.exists) {
                return result2.jid;
            }
        }
    }
    return null;
}

// --- INTERFACE WEB (Protegida) ---
app.get('/', authMiddleware, async (req, res) => {
    let statusHtml = "";
    if (sock?.user) {
        statusHtml = `<h2 style="color:#25D366; margin-bottom: 5px;">✅ SEP ONLINE</h2>
                      <p style="margin-top: 0; color: #555;">WhatsApp Conectado: <strong>${sock.user.id.split(':')[0]}</strong></p>
                      <button onclick="if(confirm('Tem certeza que deseja desconectar este número? Será necessário escanear um novo QR Code.')) { window.location.href='/desconectar'; }" 
                              style="margin-top: 15px; background-color: #dc3545; color: white; border: none; padding: 8px 16px; border-radius: 5px; cursor: pointer; font-weight: bold; font-size: 13px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
                          🔌 Desconectar Sessão
                      </button>`;
    } else if (qrCodeDinamico) {
        const url = await QRCode.toDataURL(qrCodeDinamico);
        statusHtml = `<h2>SEP - Escanear Aparelho</h2>
                      <img src="${url}" width="220" style="border:5px solid white; border-radius:10px; box-shadow:0 4px 10px rgba(0,0,0,0.1); margin-bottom: 10px;"/>
                      <p style="color:#666; font-size: 13px; margin: 0;">Aguardando leitura do QR Code...</p>`;
    } else {
        statusHtml = `<h2 style="color: #666;">Iniciando serviço SEP...</h2>`;
    }

    res.send(`
        <!DOCTYPE html>
        <html>
            <head>
                <meta http-equiv="refresh" content="7">
                <title>${config.nomesistema}</title>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; background: #f0f2f5; padding: 20px; margin: 0; }
                    .header { background: #075E54; color: white; padding: 15px; margin: -20px -20px 20px -20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
                    .header h1 { margin: 0; font-size: 20px; font-weight: 500; }
                    .card { background: white; padding: 30px; border-radius: 12px; display: inline-block; box-shadow: 0 2px 10px rgba(0,0,0,0.05); min-width: 320px; margin-bottom: 40px; }
                    .log-container { text-align: left; width: 90%; max-width: 600px; margin: 0 auto; padding-top: 15px; height: 150px; overflow-y: auto; font-family: monospace; font-size: 12px; color: #999; border-top: 1px solid #ddd; }
                    .log-title { color: #bbb; font-weight: bold; font-size: 11px; text-transform: uppercase; margin-bottom: 8px; display: block; letter-spacing: 1px; }
                    button:hover { background-color: #c82333 !important; }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>Módulo SEP - Envio de Tokens</h1>
                </div>
                
                <div class="card">
                    ${statusHtml}
                </div>

                <div class="log-container">
                    <span class="log-title">Últimos registros do sistema</span>
                    ${logHistory.slice().reverse().join('<br>')}
                </div>
            </body>
        </html>
    `);
});

// --- ROTA PARA DESCONECTAR E APAGAR SESSÃO (Protegida) ---
app.get('/desconectar', authMiddleware, async (req, res) => {
    console.log('🔌 Solicitada desconexão via painel Web.');
    
    if (sock) {
        try {
            await sock.logout();
        } catch (err) {
            console.log('Erro ao tentar fazer logout do socket:', err);
        }
    }

    setTimeout(() => {
        try {
            fs.rmSync('auth_api', { recursive: true, force: true });
            console.log('🗑️ Arquivos da sessão antiga (auth_api) foram apagados.');
        } catch (e) {
            console.log('Erro ao apagar pasta:', e);
        }
        
        qrCodeDinamico = null;
        sock = null;
        
        startAPI();
    }, 1500);

    res.send(`
        <script>
            alert('WhatsApp desconectado com sucesso! A sessão foi limpa.');
            window.location.href = '/';
        </script>
    `);
});

// --- ENDPOINT DE ENVIO (Livre para PHP) ---
app.post('/enviar', async (req, res) => {
    const { numero, mensagem } = req.body;
    if (!sock?.user) return res.status(500).json({ erro: "WhatsApp desconectado" });

    try {
        let jid = formatToJid(numero);
        let validJid = await validarNumeroWhatsapp(jid);

        if (!validJid) {
            console.log(`❌ ERRO SEP: O número ${numero} não possui WhatsApp ativo.`);
            return res.status(400).json({ erro: "Número não possui WhatsApp ativo." });
        }

        await sock.sendMessage(validJid, { text: mensagem });
        
        console.log(`📤 TOKEN ENVIADO -> ${validJid.split('@')[0]}`);
        res.json({ status: "sucesso", destino_real: validJid });
    } catch (e) {
        console.log(`❌ Erro no envio SEP: ${e.message}`);
        res.status(500).json({ erro: e.message });
    }
});

// --- VERIFICADOR DE INTERNET ---
function aguardarInternetEReconectar() {
    console.log('🌐 Verificando conexão com a rede...');

    dns.resolve('www.google.com', (err) => {
        if (err) {
            console.log('❌ Sem internet. Aguardando 30s para tentar novamente...');
            setTimeout(aguardarInternetEReconectar, 30000);
        } else {
            console.log('✅ Internet estável! Retomando conexão com o WhatsApp...');
            setTimeout(() => startAPI(), 5000);
        }
    });
}

// --- LÓGICA DE CONEXÃO ---
async function startAPI() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_api');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        syncFullHistory: false,
        markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCodeDinamico = qr;
            console.log('\n--- SEP: NOVO QR CODE GERADO ---\n');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'open') {
            qrCodeDinamico = null;
            console.log('--------------------------------------------------');
            console.log(`🚀 ${config.nomesistema} ATIVO NA PORTA ${config.port}`);
            console.log('--------------------------------------------------');
        }

        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            
            if (sock) {
                sock.ev.removeAllListeners();
                try { sock.ws.close(); } catch(e) {}
            }

            if (reason === DisconnectReason.loggedOut) {
                console.log("❌ Sessão encerrada (Deslogado). Limpando dados para gerar novo QR Code...");
                try { fs.rmSync('auth_api', { recursive: true, force: true }); } catch (e) {}
                setTimeout(() => startAPI(), 2000);
            } else {
                console.log(`⚠️ Conexão caiu (Motivo: ${reason}). Acionando protocolo de espera de rede...`);
                aguardarInternetEReconectar();
            }
        }
    });
}

app.listen(config.port, config.host, () => {
    console.log(`Servidor SEP ativo em http://${config.host}:${config.port} (Protegido por senha)`);
});

startAPI();