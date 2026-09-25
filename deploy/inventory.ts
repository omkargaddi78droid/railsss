// Builds deploy/inventory.json from the Terraform outputs (run after every `terraform apply`).
//
//   node deploy/inventory.ts            # or --main-output file.json --k6-output file.json
//
// Default roles for N hosts: node01..node(N-2) worker, node(N-1) api + nginx, nodeN redis +
// monitoring. Roles already in inventory.json are kept for hosts with the same name, so edit the
// file to reassign (e.g. two api hosts); every host also runs node-exporter and cAdvisor.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Host, Inventory, Role } from "./render.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROLES: Role[] = ["worker", "api", "nginx", "redis", "monitoring"];

function tfOutput(dir: string, file?: string): Record<string, { value: unknown }> {
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  return JSON.parse(execFileSync("terraform", [`-chdir=${dir}`, "output", "-json"], { encoding: "utf8" }));
}

export function defaultRoles(index: number, count: number): Role[] {
  if (count < 3) throw new Error("need at least 3 hosts (workers, gateway, data)");
  if (index === count - 2) return ["api", "nginx"];
  if (index === count - 1) return ["redis", "monitoring"];
  return ["worker"];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const out = tfOutput(join(here, "terraform/main"), arg("--main-output"));
  const nodes = out.nodes.value as { name: string; public_ip: string; private_ip: string }[];
  const path = join(here, "inventory.json");
  const previous = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Inventory) : null;
  const kept = new Map(previous?.hosts.map((h) => [h.name, h.roles]) ?? []);

  const hosts: Host[] = nodes.map((n, i) => ({
    name: n.name, public_ip: n.public_ip, private_ip: n.private_ip,
    roles: kept.get(n.name) ?? defaultRoles(i, nodes.length),
  }));
  for (const h of hosts) {
    const bad = h.roles.filter((r) => !ROLES.includes(r));
    if (bad.length) throw new Error(`${h.name}: unknown roles ${bad.join(", ")}`);
  }

  let k6: Inventory["k6"];
  try {
    const k6out = tfOutput(join(here, "terraform/k6"), arg("--k6-output"));
    k6 = { public_ip: k6out.public_ip.value as string };
  } catch {
    console.warn("no k6 terraform output (apply deploy/terraform/k6 in the other account first); k6 left out");
  }

  const repos = out.repositories.value as { engine: string; api: string };
  const inv: Inventory = {
    region: out.region.value as string,
    instance_type: out.instance_type.value as string,
    registry: out.registry.value as string,
    repositories: { engine: repos.engine, api: repos.api },
    hosts,
    ...(k6 ? { k6 } : {}),
  };
  writeFileSync(path, JSON.stringify(inv, null, 2) + "\n");
  // fresh instances reuse old public IPs with new host keys
  rmSync(join(here, ".known_hosts"), { force: true });
  for (const h of hosts) console.log(`${h.name.padEnd(8)} ${h.public_ip.padEnd(16)} ${h.private_ip.padEnd(14)} ${h.roles.join(",")}`);
  if (k6) console.log(`k6       ${k6.public_ip}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
