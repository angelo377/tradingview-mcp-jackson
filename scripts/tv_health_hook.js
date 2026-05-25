#!/usr/bin/env node
/**
 * tv_health_hook.js — UserPromptSubmit hook for Claude Code
 *
 * Handles two commands:
 *   tv_health_check  — full 32-symbol scan + render chart panel (~2 min)
 *   tv_panel         — instantly re-render last scan results from cache
 */
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname      = dirname(fileURLToPath(import.meta.url));
const FULL_SCRIPT    = join(__dirname, 'tv_healthcheck_full.js');
const PANEL_SCRIPT   = join(__dirname, 'tv_panel.js');
const EARNINGS_SCRIPT = join(__dirname, 'tv_earnings.js');
const CYCLE_SCRIPT   = join(__dirname, 'tv_cycle.js');

// Read stdin (Claude Code pipes JSON: { session_id, prompt, cwd })
const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(Buffer.concat(chunks).toString()); } catch {}

  const prompt = (payload.prompt || '').trim();

  if (prompt === 'tv_health_check') {
    try {
      const out = execSync(`node "${FULL_SCRIPT}"`, {
        timeout: 480000,
        encoding: 'utf-8',
      });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: out,
        },
      }));
    } catch (e) {
      const errMsg = e.stdout || e.stderr || e.message;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `TV Health Check failed:\n${errMsg}`,
        },
      }));
    }
    process.exit(0);
  }

  if (prompt === 'tv_panel') {
    try {
      const out = execSync(`node "${PANEL_SCRIPT}"`, {
        timeout: 15000,
        encoding: 'utf-8',
      });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: out,
        },
      }));
    } catch (e) {
      const errMsg = e.stdout || e.stderr || e.message;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `tv_panel failed:\n${errMsg}`,
        },
      }));
    }
    process.exit(0);
  }

  if (prompt === 'tv_earnings') {
    try {
      const out = execSync(`node "${EARNINGS_SCRIPT}"`, {
        timeout: 15000,
        encoding: 'utf-8',
      });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: out,
        },
      }));
    } catch (e) {
      const errMsg = e.stdout || e.stderr || e.message;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `tv_earnings failed:\n${errMsg}`,
        },
      }));
    }
    process.exit(0);
  }

  if (prompt === 'tv_cycle') {
    try {
      const out = execSync(`node "${CYCLE_SCRIPT}"`, {
        timeout: 480000,
        encoding: 'utf-8',
      });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: out,
        },
      }));
    } catch (e) {
      const errMsg = e.stdout || e.stderr || e.message;
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: `tv_cycle failed:\n${errMsg}`,
        },
      }));
    }
    process.exit(0);
  }

  // Not our command — exit silently, prompt proceeds normally
  process.exit(0);
});
