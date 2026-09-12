import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const binary = required("BWRAP");
const args = JSON.parse(required("BWRAP_ARGS"));
const child = spawn(binary, args, {
  env: {},
  stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", "pipe"],
});
const release = child.stdio[3];
const ready = child.stdio[4];
const status = child.stdio[5];
if (!release || !ready || !status || !child.stdout)
  throw new Error("fixture control pipe unavailable");

let resolveStartup;
let rejectStartup;
let startupSeen = false;
const startup = new Promise((resolve, reject) => {
  resolveStartup = resolve;
  rejectStartup = reject;
});
let statusText = "";
status.setEncoding("utf8");
status.on("data", (chunk) => {
  try {
    statusText += chunk;
    for (;;) {
      const newline = statusText.indexOf("\n");
      if (newline === -1) break;
      const frame = JSON.parse(statusText.slice(0, newline));
      statusText = statusText.slice(newline + 1);
      if (typeof frame["child-pid"] === "number") {
        startupSeen = true;
        resolveStartup(frame["child-pid"]);
      }
    }
  } catch (error) {
    rejectStartup(error);
  }
});
status.once("error", rejectStartup);
status.once("end", () => {
  if (statusText.length !== 0) rejectStartup(new Error("incomplete fixture status frame"));
  else if (!startupSeen) rejectStartup(new Error("fixture status ended before startup"));
});

const [startupPid] = await Promise.all([startup, waitForReady(ready)]);
const init = await captureIdentity(startupPid);
if (process.env.HOST_DEATH_BEFORE_RELEASE === "1") {
  await writeReport({ init });
  process.exit(0);
}

await end(release, "PI_CONDUCTOR_BOOTSTRAP_RELEASE_V1");
const namespacePid = await readDescendantPid(child.stdout);
const descendantStatus = await readFile(`/proc/${init.pid}/root/proc/${namespacePid}/status`, "utf8");
if (descendantStatus.match(/^NSpid:\s+(.+)$/m)?.[1]?.trim() !== namespacePid)
  throw new Error("fixture descendant namespace PID changed before host mapping");
const bootstrapChildren = await readChildren(init.pid);
if (bootstrapChildren.length !== 1)
  throw new Error(`fixture expected one bootstrap child, found ${bootstrapChildren.length}`);
const bootstrap = await captureIdentity(bootstrapChildren[0]);
const descendantChildren = await readChildren(bootstrap.pid);
if (descendantChildren.length !== 1)
  throw new Error(`fixture expected one background descendant, found ${descendantChildren.length}`);
const descendant = await captureIdentity(descendantChildren[0]);
const finalInit = await captureIdentity(init.pid);
if (finalInit.start !== init.start) throw new Error("fixture init PID changed identity while mapped");
const finalBootstrap = await captureIdentity(bootstrap.pid);
if (finalBootstrap.start !== bootstrap.start)
  throw new Error("fixture bootstrap PID changed identity while mapped");
const finalDescendant = await captureIdentity(descendant.pid);
if (finalDescendant.start !== descendant.start)
  throw new Error("fixture descendant PID changed identity while mapped");
await writeReport({ init, descendant });
process.exit(0);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing fixture environment ${name}`);
  return value;
}

function captureIdentity(pid) {
  return readFile(`/proc/${pid}/stat`, "utf8").then((stat) => {
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const start = fields[19];
    if (!start) throw new Error(`fixture could not read start time for PID ${pid}`);
    return { pid, start };
  });
}

function end(stream, frame) {
  return new Promise((resolve, reject) =>
    stream.end(frame, (error) => (error ? reject(error) : resolve())),
  );
}

function waitForReady(stream) {
  return new Promise((resolve, reject) => {
    let received = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      received += chunk;
      if (received === "READY\n") resolve();
      else if (!"READY\n".startsWith(received))
        reject(new Error(`invalid fixture READY ${received}`));
    });
    stream.once("error", reject);
    stream.once("end", () => reject(new Error("fixture READY pipe ended")));
  });
}

function readDescendantPid(stream) {
  return new Promise((resolve, reject) => {
    let output = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/DESCENDANT_NSPID=(\d+)/);
      if (match?.[1]) resolve(match[1]);
    });
    stream.once("error", reject);
    stream.once("end", () => reject(new Error(`missing descendant marker: ${output}`)));
  });
}

function readChildren(pid) {
  return readFile(`/proc/${pid}/task/${pid}/children`, "utf8").then((contents) =>
    contents.trim().split(/\s+/).filter(Boolean).map(Number),
  );
}

function writeReport(report) {
  return new Promise((resolve, reject) =>
    process.stdout.write(`${JSON.stringify(report)}\n`, (error) => (error ? reject(error) : resolve())),
  );
}
