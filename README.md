npm init -y

npm install express qrcode qrcode-terminal @whiskeysockets/baileys @hapi/boom pino moment

pm2 start index.js --name api-sep --max-memory-restart 250M

pm2 save
