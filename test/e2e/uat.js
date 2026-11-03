// Client for uat-server.js:  node uat.js <session> <command> [args...]
const http = require("http");
const [session, command, ...args] = process.argv.slice(2);
const body = JSON.stringify({ session, command, args });

// Retry refused connections for a while so a server restart looks like a pause.
function send(attempt) {
  const req = http.request(
    { host: "127.0.0.1", port: Number(process.env.UAT_PORT || 47391), method: "POST", path: "/" },
    (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => {
        console.log(res.statusCode === 200 ? out : `ERROR: ${out}`);
        process.exitCode = res.statusCode === 200 ? 0 : 1;
      });
    }
  );
  req.setTimeout(180000);
  req.on("error", (e) => {
    if (e.code === "ECONNREFUSED" && attempt < 30) {
      setTimeout(() => send(attempt + 1), 1000);
      return;
    }
    console.log(`ERROR: can't reach the UAT server (${e.code})`);
    process.exitCode = 2;
  });
  req.end(body);
}
send(0);
