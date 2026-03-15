import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { buildRequestContext } from "../src/agent/contextBuilder.js";
import { createMessage } from "../src/agent/messages.js";
import { discoverSkills } from "../src/skills/catalog.js";
import { loadSkillTool } from "../src/tools/skills/loadSkillTool.js";
import { createTempWorkspace, makeToolContext } from "./helpers.js";

test("discoverSkills + load_skill load skill bodies on demand", async (t) => {
  const root = await createTempWorkspace("skills", t);
  const skillDir = path.join(root, "skills", "demo-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      "name: demo-skill",
      "description: Demo skill for tests",
      "required: true",
      "triggers: demo,skill",
      "---",
      "# Demo Skill",
      "Use this specialized workflow.",
    ].join("\n"),
    "utf8",
  );

  const skills = await discoverSkills(root, root, []);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "demo-skill");
  assert.equal(skills[0]?.required, true);

  const output = await loadSkillTool.execute(
    JSON.stringify({ name: "demo-skill" }),
    makeToolContext(root, root, {
      projectContext: {
        stateRootDir: root,
        skills,
      },
    }) as any,
  );

  assert.equal(output.ok, true);
  assert.match(output.output, /<skill name="demo-skill"/);
  assert.match(output.output, /Use this specialized workflow\./);
});

test("buildRequestContext compresses oversized histories with a summary", () => {
  const messages = Array.from({ length: 40 }, (_, index) => {
    const body = `${index} `.repeat(300);
    return index % 2 === 0
      ? createMessage("user", `user-${body}`)
      : createMessage("assistant", `assistant-${body}`);
  });

  const built = buildRequestContext("system", messages, {
    contextWindowMessages: 30,
    model: "deepseek-reasoner",
    maxContextChars: 8_000,
    contextSummaryChars: 1_200,
  });

  assert.equal(built.compressed, true);
  assert.ok(built.summary);
  assert.ok(built.messages.length < messages.length + 1);
  assert.ok(built.estimatedChars > 0);
});
