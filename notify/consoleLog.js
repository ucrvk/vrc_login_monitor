async function sendConsoleLog(payload) {
    const timestamp = new Date().toISOString();
    const line = `[notify:consoleLog][${timestamp}][${payload.type}]`;
    console.log(line, JSON.stringify(payload.content));
}

module.exports = {
    send: sendConsoleLog
};
