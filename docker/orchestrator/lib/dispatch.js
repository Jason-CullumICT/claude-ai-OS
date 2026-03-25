/**
 * Dispatch Plan Parsing
 *
 * Extracted from server.js — all functions that handle parsing the leader's
 * output into structured agent dispatch stages.
 *
 * Usage:
 *   const { createDispatcher } = require("./lib/dispatch");
 *   const dispatch = createDispatcher(runClaude, WORKSPACE);
 *   const plan = await dispatch.parseDispatchPlan(leaderOutput, task, team);
 */

const { readFileSync, existsSync, readdirSync, statSync } = require("fs");
const { join } = require("path");

function createDispatcher(runClaudeFn, workspace) {
  /**
   * Extract JSON from Claude's text output (handles markdown fences, preamble).
   */
  function extractJson(text) {
    const trimmed = text.trim();
    try { return JSON.parse(trimmed); } catch {}
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) try { return JSON.parse(fenced[1].trim()); } catch {}
    const braceMatch = trimmed.match(/\{[\s\S]*\}/);
    if (braceMatch) try { return JSON.parse(braceMatch[0]); } catch {}
    throw new Error("No valid JSON found in output");
  }

  /**
   * Scan workspace for plan-related files the leader created.
   */
  function findPlanContext() {
    const ctx = { specs: [], plans: [], contracts: [], dispatchPlan: null, planDir: null };

    const specsDir = join(workspace, "Specifications");
    if (existsSync(specsDir)) {
      try {
        for (const f of readdirSync(specsDir)) {
          if (f.endsWith(".md")) ctx.specs.push(`Specifications/${f}`);
        }
      } catch {}
    }

    const plansDir = join(workspace, "Plans");
    if (existsSync(plansDir)) {
      try {
        for (const entry of readdirSync(plansDir)) {
          const sub = join(plansDir, entry);
          if (!existsSync(sub) || !statSync(sub).isDirectory()) continue;
          for (const f of readdirSync(sub)) {
            const rel = `Plans/${entry}/${f}`;
            if (f === "dispatch-plan.md") { ctx.dispatchPlan = rel; ctx.planDir = `Plans/${entry}`; }
            else if (/contract/i.test(f)) ctx.contracts.push(rel);
            else if (f.endsWith(".md")) ctx.plans.push(rel);
          }
        }
      } catch {}
    }

    return ctx;
  }

  /**
   * Extract agent role names from a dispatch plan file.
   * Uses regex first, falls back to Claude for ambiguous formats.
   */
  async function extractRoles(dispatchContent, leaderOutput) {
    const roles = new Set();

    // Extract from markdown headings: ## backend-coder-1, ### frontend-coder
    for (const m of dispatchContent.matchAll(/^#{2,4}\s+(?:\*\*)?([a-z][\w-]+(?:-\d+)?)(?:\*\*)?/gim)) {
      roles.add(m[1].toLowerCase());
    }
    // From bold table cells: | **backend-coder-1** |
    for (const m of dispatchContent.matchAll(/\|\s*\*\*([a-z][\w-]+(?:-\d+)?)\*\*/gi)) {
      roles.add(m[1].toLowerCase());
    }
    // From bold list items: - **backend-coder-1** or * **qa-review**
    for (const m of dispatchContent.matchAll(/[-*]\s+\*\*([a-z][\w-]+(?:-\d+)?)\*\*/gi)) {
      roles.add(m[1].toLowerCase());
    }
    // From leader stdout: agent names mentioned
    for (const m of leaderOutput.matchAll(/\b(backend-coder-?\d*|frontend-coder-?\d*|qa-review[\w-]*|security-qa|traceability[\w-]*|chaos[\w-]*|visual[\w-]*|design[\w-]*|integration[\w-]*|playwright[\w-]*)\b/gi)) {
      roles.add(m[1].toLowerCase());
    }

    // Filter to agent-like names only
    const agentRoles = [...roles].filter((r) =>
      /coder|fixer|qa|security|review|test|chaos|traceability|visual|design|integration|critic|playwright/i.test(r)
    );

    if (agentRoles.length > 0) {
      console.log(`[dispatch] Regex extracted ${agentRoles.length} roles: ${agentRoles.join(", ")}`);
      return classifyRoles(agentRoles);
    }

    // Fallback: ask Claude to extract just the role names (simple task)
    console.log("[dispatch] Regex found no roles, asking Claude...");
    const prompt = `Extract agent role names from this dispatch plan. Return ONLY JSON.

"""
${dispatchContent.slice(0, 12000)}
"""

{"implementation": ["role-name-1", "role-name-2"], "qa": ["role-name-1"]}`;

    const result = await runClaudeFn(prompt, { maxTurns: 1, label: "role-extractor", quiet: true });
    if (result.exitCode !== 0) throw new Error("Role extraction failed");
    return extractJson(result.stdout);
  }

  /**
   * Classify role names into implementation vs QA.
   */
  function classifyRoles(roles) {
    const impl = [];
    const qa = [];
    for (const r of roles) {
      if (/coder|fixer/i.test(r)) impl.push(r);
      else qa.push(r);
    }
    return { implementation: impl, qa };
  }

  /**
   * Build a self-contained prompt for an agent.
   * Agents read the dispatch plan file themselves to find their specific assignments.
   */
  function buildAgentPrompt(role, task, team, planCtx) {
    const isImpl = /coder|fixer/i.test(role);
    // Strip trailing number for role file lookup (backend-coder-1 -> backend-coder.md)
    const roleBase = role.replace(/-\d+$/, "");
    const roleFile = `Teams/${team}/${roleBase}.md`;
    const learningsFile = `Teams/${team}/learnings/${roleBase}.md`;

    let p = `Read CLAUDE.md first for project context and rules.\n\n`;
    p += `Read the role file at ${roleFile} and follow it (if it exists).\n`;
    p += `Read your learnings file at ${learningsFile} before starting (if it exists).\n\n`;

    if (planCtx.dispatchPlan) {
      p += `IMPORTANT: Read the dispatch plan at ${planCtx.dispatchPlan} and find the section for "${role}". Follow the assignments and instructions for your specific role.\n\n`;
    }

    p += `Task: ${task}\nYour role: ${role}\nTeam: ${team}\n\n`;

    if (planCtx.specs.length > 0) p += `Specifications: ${planCtx.specs.join(", ")}\n`;
    if (planCtx.contracts.length > 0) p += `API Contracts: ${planCtx.contracts.join(", ")}\n`;
    if (planCtx.plans.length > 0) p += `Plans: ${planCtx.plans.join(", ")}\n`;
    p += "\n";

    if (isImpl) {
      p += `Implementation rules:
- Read your section in the dispatch plan for specific FR assignments and module scope
- Implement according to the API contracts and specifications
- Add // Verifies: FR-XXX traceability comments to all code and tests
- Use structured logging (not console.log), add Prometheus metrics for domain operations
- Follow the service layer pattern (no direct DB calls from route handlers)
- All list endpoints return {data: T[]} wrappers
- Run all verification gates before completing (tests, traceability enforcer, type check)
- Update your learnings file with any discoveries`;
    } else {
      p += `QA rules:
- Review the implementation against specifications and contracts
- Run all tests and verification gates
- Run python3 tools/traceability-enforcer.py if available
- Check for security issues, architecture violations, and missing traceability
- Write your report to ${planCtx.planDir || "Plans"}/
- Do NOT edit Source/ files — report issues only
- Report findings with severity ratings (CRITICAL, HIGH, MEDIUM, LOW, INFO)`;

      // Verifies: FR-TMP-002
      // Augment QA prompts with E2E test generation instructions
      const runId = planCtx.runId || "unknown";
      p += `\n\nAdditionally, write Playwright E2E test files at Source/E2E/tests/cycle-${runId}/ that verify the feature works in a real browser. Tests must run against http://localhost:5173. Use @playwright/test. Each test navigates to a page, interacts with UI elements, and asserts expected outcomes. Import { test, expect } from '@playwright/test'. Create at least one test file per major feature change.`;
    }

    return p;
  }

  /**
   * Parse leader output into structured dispatch stages.
   * Strategy: read dispatch plan file -> extract roles -> build prompts in Node.js
   */
  async function parseDispatchPlan(leaderOutput, task, team) {
    const planCtx = findPlanContext();

    if (planCtx.dispatchPlan) {
      console.log(`[dispatch] Found dispatch plan: ${planCtx.dispatchPlan}`);
      const dpContent = readFileSync(join(workspace, planCtx.dispatchPlan), "utf-8");

      const roles = await extractRoles(dpContent, leaderOutput);
      console.log(`[dispatch] Roles: impl=[${(roles.implementation || []).join(", ")}] qa=[${(roles.qa || []).join(", ")}]`);

      const stages = [];
      if (roles.implementation && roles.implementation.length > 0) {
        stages.push({
          name: "implementation",
          parallel: roles.implementation.length > 1,
          agents: roles.implementation.map((role) => ({
            role,
            prompt: buildAgentPrompt(role, task, team, planCtx),
          })),
        });
      }
      if (roles.qa && roles.qa.length > 0) {
        stages.push({
          name: "qa",
          parallel: roles.qa.length > 1,
          agents: roles.qa.map((role) => ({
            role,
            prompt: buildAgentPrompt(role, task, team, planCtx),
          })),
        });
      }

      if (stages.length > 0) {
        console.log(`[dispatch] Built ${stages.length} stages: ${stages.map((s) => `${s.name}(${s.agents.length}${s.parallel ? ",parallel" : ""})`).join(" → ")}`);
        return { stages };
      }
    } else {
      console.log("[dispatch] No dispatch plan file found in Plans/");
    }

    throw new Error("Could not extract roles from dispatch plan");
  }

  /**
   * Build a minimal fallback plan when Claude parsing fails.
   */
  function buildFallbackPlan(task, team, leaderOutput) {
    const planRefs = (leaderOutput.match(/Plans?\/[\w\-\/]+\.md/gi) || []).slice(0, 5);
    const planNote = planRefs.length > 0 ? `\nPlan files created by leader: ${planRefs.join(", ")}` : "";

    if (team === "TheFixer") {
      return {
        stages: [{
          name: "fix",
          parallel: false,
          agents: [{
            role: "fixer",
            prompt: `Read CLAUDE.md first for project context and rules.\n\nFix: ${task}${planNote}\n\nCheck Plans/ for the fix plan. Run all verification gates before completing.`,
          }],
        }],
      };
    }

    return {
      stages: [
        {
          name: "implementation",
          parallel: false,
          agents: [{
            role: "coder",
            prompt: `Read CLAUDE.md first for project context and rules.\n\nImplement: ${task}${planNote}\n\nCheck Plans/ for the implementation plan and API contracts. Run verification gates before completing.`,
          }],
        },
        {
          name: "qa",
          parallel: true,
          agents: [{
            role: "qa-review",
            prompt: `Read CLAUDE.md first for project context and rules.\n\nReview and test the implementation of: ${task}${planNote}\n\nRun all tests, verify traceability (tools/traceability-enforcer.py), check for security issues.`,
          }],
        },
      ],
    };
  }

  return {
    findPlanContext,
    extractRoles,
    classifyRoles,
    buildAgentPrompt,
    parseDispatchPlan,
    buildFallbackPlan,
    extractJson,
  };
}

module.exports = { createDispatcher };
