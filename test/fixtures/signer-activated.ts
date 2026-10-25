// Lanceur de test qui imite systemd : le socket est déjà le descripteur 3 du processus, et
// LISTEN_PID doit désigner ce processus (systemd le fixe après le fork ; ici, avant l'import).
process.env['LISTEN_PID'] = String(process.pid);
process.env['LISTEN_FDS'] = '1';
await import('../../src/signer/main.js');
