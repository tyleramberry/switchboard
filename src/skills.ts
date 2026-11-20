import { existsSync, readdirSync, readFileSync, lstatSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { homePaths } from "./home.js";
import { containedPath, splitFrontmatter, PathError } from "./memory.js";

export interface SkillInfo {
  name: string;
  description: string;
  files: string[];
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function listFiles(dir: string, base: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const f = join(dir, e.name);
    if (e.isDirectory()) listFiles(f, base, out);
    else if (e.isFile()) out.push(relative(base, f));
  }
  return out;
}

export class SkillStore {
  readonly dir: string;
  constructor(root: string) {
    this.dir = homePaths(root).skills;
  }

  list(): SkillInfo[] {
    if (!existsSync(this.dir)) return [];
    const out: SkillInfo[] = [];
    for (const e of readdirSync(this.dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !SKILL_NAME.test(e.name)) continue; // symlinked dirs skipped
      const md = join(this.dir, e.name, "SKILL.md");
      if (!existsSync(md) || !lstatSync(md).isFile()) continue;
      const { meta } = splitFrontmatter(readFileSync(md, "utf8"));
      out.push({
        name: String(meta.name ?? e.name),
        description: String(meta.description ?? ""),
        files: listFiles(join(this.dir, e.name), join(this.dir, e.name)).sort(),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string, file = "SKILL.md"): { name: string; file: string; content: string } {
    if (!SKILL_NAME.test(name)) throw new PathError("invalid skill name");
    const skillDir = join(this.dir, name);
    if (!existsSync(skillDir) || !lstatSync(skillDir).isDirectory()) throw new PathError("skill not found");
    const real = containedPath(skillDir, file);
    if (!lstatSync(real).isFile()) throw new PathError("not a file");
    return { name, file: relative(realpathSync(skillDir), real), content: readFileSync(real, "utf8") };
  }

  /** Overwrite an existing file inside a skill folder (UI editor). */
  put(name: string, file: string, content: string): { name: string; file: string } {
    const cur = this.get(name, file); // validates name, containment, existence
    writeFileSync(join(realpathSync(join(this.dir, name)), cur.file), content);
    return { name, file: cur.file };
  }

  /** Create a new skill folder with a SKILL.md. Refuses if it already exists. */
  create(name: string, description: string, body?: string): { name: string; file: string } {
    if (!SKILL_NAME.test(name)) throw new PathError("skill name must be lowercase letters, digits, . _ - (max 64)");
    const dir = join(this.dir, name);
    if (existsSync(dir)) throw new PathError(`skill ${name} already exists`);
    mkdirSync(dir, { recursive: true });
    const desc = description.replace(/\r?\n/g, " ").trim();
    const text = `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n\n${(body ?? `# ${name}\n\n1. Step one.\n2. Step two.\n`).trimEnd()}\n`;
    writeFileSync(join(dir, "SKILL.md"), text, { flag: "wx", mode: 0o644 });
    return { name, file: "SKILL.md" };
  }
}
