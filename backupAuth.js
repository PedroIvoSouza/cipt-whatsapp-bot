const fs = require('fs');
const archiver = require('archiver');
const CryptoJS = require('crypto-js');

const PASSWORD = process.env.AUTH_BACKUP_KEY; // Defina no Render como variável de ambiente

async function backupAuth() {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream('auth-backup.zip');
    const archive = archiver('zip');

    output.on('close', () => {
      const zipData = fs.readFileSync('auth-backup.zip');
      const encrypted = CryptoJS.AES.encrypt(
        zipData.toString('base64'),
        PASSWORD
      ).toString();
      fs.writeFileSync('auth-backup.enc', encrypted);
      fs.unlinkSync('auth-backup.zip');
      console.log('✅ Backup criptografado salvo em auth-backup.enc');
      resolve();
    });

    archive.on('error', reject);

    archive.pipe(output);
    archive.directory('auth/', false);
    archive.finalize();
  });
}

backupAuth().catch(err => console.error('❌ Erro no backup:', err));