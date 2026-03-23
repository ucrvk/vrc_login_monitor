async function sendConsoleLog(payload) {
    const timestamp = new Date().toISOString();
    const line = `[notify:consoleLog][${timestamp}][${payload.type}]`;
    console.log(line, payload.message || payload.type);
}

module.exports = {
    send: sendConsoleLog
};
