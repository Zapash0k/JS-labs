// npm run dev: starts the Node server and the Vite client together; Ctrl+C stops both.
import { spawn } from "node:child_process";

const run = (name, args) => {
  const child = spawn("npm", ["run", ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => {
    console.log(`[${name}] exited (${code})`);
    stopAll();
  });
  return child;
};
const children = [run("server", ["dev", "-w", "server"]), run("client", ["dev", "-w", "client"])];
let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill("SIGTERM");
}
process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);
