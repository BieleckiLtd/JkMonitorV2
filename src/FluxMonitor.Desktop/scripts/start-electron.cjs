const { spawn } = require("node:child_process");
const path = require("node:path");

const electronExecutable = require("electron");
const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronExecutable, [path.resolve(__dirname, "..")], {
  env,
  stdio: "inherit",
  windowsHide: false
});

child.once("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.once("exit", (code) => {
  process.exit(code ?? 0);
});
