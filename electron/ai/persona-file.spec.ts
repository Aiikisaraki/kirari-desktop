// @vitest-environment node
// electron/ai/persona-file.spec.ts
// 人格独立文件（数据根下的 persona.md）的回归测试。
// 逐条对应核心版 scripts/smoke-persona-file.js 的七节断言。
//
// 背景（2026-11-25 用户拍板「人格统一都搬到独立文件」）：人格原来存在 config.json 的
// basePersona 里，三个毛病——4000 字上限、和模型密钥一损俱损、没法当明文编辑/备份/diff。
//
// 这份测试钉死搬家后最容易出错的地方：
//   1. persona.md 优先于 config.json 的老字段
//   2. 「恢复预设」必须真的删掉文件，且**不能**被老字段读回来
//   3. 超长截断到 20000，并如实返回 truncated
//   4. 原子写：不留下 .tmp 残骸
//   5. 覆盖前留备份，备份份数有界
//   6. 首次启动的迁移只搬一次，且不删老字段
//   7. 坏档（文件不可读）不抛、按未自定义处理
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ⚠️ 临时目录放在项目内（.tmp-test/）：部分沙箱环境会杀掉写系统临时目录的进程。
// vi.hoisted 早于 import 初始化执行，这里只能用纯字符串拼路径（不用 path.join）。
const tmpDir = vi.hoisted(() => `${process.cwd()}/.tmp-test/persona-file-${process.pid}`);

// 数据根用 KIRARI_HOME 显式指定：它在 resolveHome() 的优先级里排第一，
// 早于「读 electron userData」那条兜底分支 —— 只 mock app.getPath 不够稳，
// 一旦有人先调过 setHomeRoot() 或环境里已有 KIRARI_HOME，路径就绑到别的目录去了。
process.env.KIRARI_HOME = tmpDir;

// 仍然 mock 一份 electron：kirari-home 的 kirariHome() 会尝试读 app.getPath，
// 缺了它走 try/catch 兜底，语义对但日志脏。
vi.mock("electron", () => ({
    app: { getPath: () => tmpDir },
}));

beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
});

import {
    KEEP_BACKUPS,
    PERSONA_MAX_CHARS,
    backupDir,
    migrateFromConfig,
    personaPath,
    readPersonaFile,
    resolvePersona,
    writePersonaFile,
} from "./persona-file";
import { getBasePersona, getRawBasePersona, setBasePersona, writeModelConfigFile } from "../model-config";

const cfgPath = path.join(tmpDir, "config.json");

/** 清掉人格文件、备份目录与老配置，保证用例之间不串味。 */
function reset() {
    const p = personaPath();
    try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) fs.unlinkSync(p);
    } catch {
        /* ignore */
    }
    const b = backupDir();
    try {
        if (fs.existsSync(b)) {
            for (const f of fs.readdirSync(b)) {
                if (f.startsWith("persona-") && f.endsWith(".md")) fs.unlinkSync(path.join(b, f));
            }
        }
    } catch {
        /* ignore */
    }
    if (fs.existsSync(cfgPath)) fs.unlinkSync(cfgPath);
}

beforeEach(() => {
    reset();
});

afterAll(() => {
    reset();
});

describe("路径与上限", () => {
    it("人格文件落在数据根下", () => {
        expect(personaPath()).toBe(path.join(tmpDir, "persona.md"));
    });

    it("备份目录在数据根的 backups/", () => {
        expect(backupDir()).toBe(path.join(tmpDir, "backups"));
    });

    it("上限是 20000 字（比旧 config 字段的 4000 放宽 5 倍）", () => {
        expect(PERSONA_MAX_CHARS).toBe(20000);
    });

    it("备份份数上限是 10", () => {
        expect(KEEP_BACKUPS).toBe(10);
    });
});

describe("写读往返", () => {
    it("写入成功、真的落盘、读回来一样", () => {
        const w = writePersonaFile("你叫小满，说话有点冲。");
        expect(w.ok).toBe(true);
        expect(fs.existsSync(personaPath())).toBe(true);
        expect(readPersonaFile()).toBe("你叫小满，说话有点冲。");
    });

    it("原子写：不留下 .tmp 残骸", () => {
        writePersonaFile("你叫小满，说话有点冲。");
        const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes(".tmp-"));
        expect(leftovers).toEqual([]);
    });

    it("内容顺手 trim（防止一个空行被当成自定义人格）", () => {
        writePersonaFile("  你叫小满。  \n");
        expect(readPersonaFile()).toBe("你叫小满。");
    });
});

describe("内容没变就不重写（避免每轮触发备份 + 写盘）", () => {
    it("mtime 没变", () => {
        writePersonaFile("你叫小满，说话有点冲。");
        const mtime1 = fs.statSync(personaPath()).mtimeMs;
        writePersonaFile("你叫小满，说话有点冲。");
        const mtime2 = fs.statSync(personaPath()).mtimeMs;
        expect(mtime2).toBe(mtime1);
    });

    it("没变时不产生备份", () => {
        writePersonaFile("你叫小满。");
        writePersonaFile("你叫小满。");
        const backups = fs.existsSync(backupDir())
            ? fs.readdirSync(backupDir()).filter((f) => f.startsWith("persona-"))
            : [];
        expect(backups.length).toBe(0);
    });

    it("内容变了才写，并留一份备份", () => {
        writePersonaFile("第一版人格");
        writePersonaFile("第二版人格");
        expect(readPersonaFile()).toBe("第二版人格");
        const backups = fs.readdirSync(backupDir()).filter((f) => f.startsWith("persona-"));
        expect(backups.length).toBe(1);
        expect(fs.readFileSync(path.join(backupDir(), backups[0]), "utf8")).toContain("第一版人格");
    });
});

describe("超长截断", () => {
    it("截断到 20000，并如实报告 truncated", () => {
        const w = writePersonaFile("啊".repeat(30000));
        expect(w.saved.length).toBe(20000);
        expect(w.truncated).toBe(true);
        expect(readPersonaFile().length).toBe(20000);
    });

    it("没超长时 truncated 为 false", () => {
        expect(writePersonaFile("短人格").truncated).toBe(false);
    });
});

describe("恢复预设 = 真删文件", () => {
    it("传空串返回空内容，文件真的不存在", () => {
        writePersonaFile("要被删掉的人格");
        const w = writePersonaFile("");
        expect(w.saved).toBe("");
        expect(fs.existsSync(personaPath())).toBe(false);
        expect(readPersonaFile()).toBe("");
    });

    it("★ 恢复预设后，老字段不能被读回来（双层存储最典型的坑）", () => {
        // 先模拟一份"升级前"的数据：人格还压在一个没清理的 config.json 里。
        fs.writeFileSync(cfgPath, JSON.stringify({ basePersona: "老字段里的人格" }, null, 2), "utf-8");
        // 用户点「恢复预设」。
        setBasePersona("");
        // 如果 setBasePersona 没顺手清老字段，回退链会立刻把它读回来，
        // 用户看到的就是「点了没反应」。
        expect(getRawBasePersona()).toBe("");
        expect(getBasePersona()).toBe("");
        expect(resolvePersona().source).toBe("none");
    });
});

describe("优先级：persona.md > config.json 老字段", () => {
    it("没有人格文件时回退到 config 老字段", () => {
        fs.writeFileSync(cfgPath, JSON.stringify({ basePersona: "老字段里的人格" }, null, 2), "utf-8");
        const r = resolvePersona();
        expect(r.source).toBe("config");
        expect(r.text).toBe("老字段里的人格");
        expect(getBasePersona()).toBe("老字段里的人格");
    });

    it("有人格文件时优先文件（老字段还在也不影响）", () => {
        fs.writeFileSync(cfgPath, JSON.stringify({ basePersona: "老字段里的人格" }, null, 2), "utf-8");
        writePersonaFile("新文件里的人格");
        const r = resolvePersona();
        expect(r.source).toBe("file");
        expect(r.text).toBe("新文件里的人格");
        expect(getBasePersona()).toBe("新文件里的人格");
    });

    it("三层都空时返回 none（交给上层回退内置 DEFAULT_PERSONA）", () => {
        const r = resolvePersona();
        expect(r.source).toBe("none");
        expect(r.text).toBe("");
    });
});

describe("写入口：设置页 / self_ops 都落到 persona.md", () => {
    it("setBasePersona 写文件、不写 config.json 的 basePersona", () => {
        const saved = setBasePersona("她说话很直。");
        expect(saved).toBe("她说话很直。");
        expect(readPersonaFile()).toBe("她说话很直。");
        expect(getRawBasePersona()).toBe("");
    });

    it("writeModelConfigFile 的 basePersona 也走人格文件（否则回退链会读到老值）", () => {
        writeModelConfigFile({ basePersona: "从设置页改的" });
        expect(readPersonaFile()).toBe("从设置页改的");
        expect(getRawBasePersona()).toBe("");
        //「恢复预设」同一入口同样要真清空
        writeModelConfigFile({ basePersona: "" });
        expect(fs.existsSync(personaPath())).toBe(false);
        expect(getBasePersona()).toBe("");
    });

    it("setBasePersona 超过 20000 字时截断（不再按 4000 砍）", () => {
        const saved = setBasePersona("啊".repeat(25000));
        expect(saved.length).toBe(20000);
    });
});

describe("坏档不炸", () => {
    it("读坏档不抛异常，按未自定义处理（空串）", () => {
        fs.mkdirSync(personaPath(), { recursive: true });
        let threw = false;
        let val = "";
        try {
            val = readPersonaFile();
        } catch {
            threw = true;
        }
        expect(threw).toBe(false);
        expect(val).toBe("");
        fs.rmdirSync(personaPath());
    });
});

describe("迁移：只搬一次，不删老字段", () => {
    it("第一次迁移成功，第二次不重复搬", () => {
        fs.writeFileSync(cfgPath, JSON.stringify({ basePersona: "要迁移过去的人格" }, null, 2), "utf-8");
        const m1 = migrateFromConfig();
        expect(m1.migrated).toBe(true);
        expect(m1.chars).toBe("要迁移过去的人格".length);
        expect(readPersonaFile()).toBe("要迁移过去的人格");
        const m2 = migrateFromConfig();
        expect(m2.migrated).toBe(false);
    });

    it("config.json 的老字段依然保留（跨版本安全：旧版本还在读它）", () => {
        fs.writeFileSync(cfgPath, JSON.stringify({ basePersona: "要迁移过去的人格" }, null, 2), "utf-8");
        migrateFromConfig();
        const cfgAfter = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        expect(cfgAfter.basePersona).toBe("要迁移过去的人格");
    });

    it("persona.md 已有内容时不覆盖（用户在文件里手改的不能被 JSON 冲掉）", () => {
        writePersonaFile("文件里已经有的");
        fs.writeFileSync(cfgPath, JSON.stringify({ basePersona: "老字段里的人格" }, null, 2), "utf-8");
        const m = migrateFromConfig();
        expect(m.migrated).toBe(false);
        expect(readPersonaFile()).toBe("文件里已经有的");
    });
});
