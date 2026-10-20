import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { paths, useBotDir } from '../../config/paths';
import { ensureRegistry, currentBot } from '../../config/bots';
import { loadConfig } from '../../config/store';
import { isComplete } from '../../config/schema';
import { resolveAppSecret } from '../../config/secret-resolver';
import { buildEventConfigUrl } from '../../config/scopes';
import { diagnoseEventSubscription, summarizeEventDiagnosis } from '../../utils/event-diagnosis';
import { createBackend } from '../../agent';
import { spawnProcessSync } from '../../platform/spawn';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** true = 降级告警（⚠️，不计入失败数）——如缺可选 scope 导致事件订阅查不了。 */
  warn?: boolean;
}

/**
 * `feishu-codex-bridge doctor` — local self-check.
 * M0 scope: agent CLI + login (codex / DSH), lark-cli, config presence.
 * Connection/session checks come online once the bridge runs (M1+).
 */
export async function runDoctor(): Promise<void> {
  const checks: Check[] = [];

  // Agent CLIs — probe both catalog backends. Either one being runnable is
  // enough; the missing one is a warning, not a hard failure (a DSH-only user
  // should not see codex as "1 项需处理").
  const codexProbe = await createBackend().doctor();
  const dshProbe = await createBackend('dsh-acp').doctor();
  const anyAgent = codexProbe.ok || dshProbe.ok;

  checks.push(
    codexProbe.ok
      ? { name: 'codex CLI', ok: true, detail: `${codexProbe.version ?? 'unknown'} (${codexProbe.location ?? '?'})` }
      : {
          name: 'codex CLI',
          ok: false,
          warn: anyAgent,
          detail: codexProbe.hint ?? '未找到。设置 CODEX_BIN，或安装 @openai/codex，或装 Codex.app',
        },
  );
  checks.push(
    dshProbe.ok
      ? { name: 'DSH CLI', ok: true, detail: `${dshProbe.version ?? 'unknown'} (${dshProbe.location ?? '?'})` }
      : {
          name: 'DSH CLI',
          ok: false,
          warn: anyAgent,
          detail: dshProbe.hint ?? '未找到。装 DeepSeek Harness 桌面版，或 npm i -g @deepseek-ai/dsh',
        },
  );

  // codex login (auth file presence — heuristic). Missing while DSH works is a
  // warning, since a DSH-only setup does not need the codex login at all.
  const codexAuth = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json');
  checks.push(
    existsSync(codexAuth)
      ? { name: 'codex 登录', ok: true, detail: codexAuth }
      : { name: 'codex 登录', ok: false, warn: anyAgent, detail: '未登录，运行 `codex login`' },
  );

  // lark-cli
  const larkVer = tryExec('lark-cli', ['--version']);
  checks.push(
    larkVer
      ? { name: 'lark-cli', ok: true, detail: larkVer }
      : { name: 'lark-cli', ok: false, detail: '未找到（onboarding 会装到私有目录）' },
  );

  // bridge config — resolve the current bot (migrating a legacy flat install)
  // and check ITS config dir, not the top-level one.
  const reg = await ensureRegistry();
  const cur = currentBot(reg);
  if (cur) useBotDir(cur.appId);
  if (cur && existsSync(paths.configFile)) {
    checks.push({
      name: 'bridge 配置',
      ok: true,
      detail: `当前机器人「${cur.name}」(${cur.appId})  共 ${reg.bots.length} 个`,
    });
  } else if (cur) {
    checks.push({ name: 'bridge 配置', ok: false, detail: `配置文件缺失：${paths.configFile}` });
  } else {
    checks.push({
      name: 'bridge 配置',
      ok: false,
      detail: '未配置，运行 `feishu-codex-bridge run`（或 `bot init`）扫码创建',
    });
  }

  // 事件订阅 — 版本信息 API 三态诊断（从未发布版本 / 缺 im.message.receive_v1 /
  // 配置齐全）。缺 scope / 网络不通 → warn 降级（⚠️，不计失败、不挡 exit code）。
  if (cur && existsSync(paths.configFile)) {
    checks.push(await checkEventSubscription());
  }

  // render
  console.log('\n🩺 feishu-codex-bridge 自检\n');
  for (const c of checks) {
    const icon = c.ok ? (c.warn ? '⚠️' : '✅') : (c.warn ? '⚠️' : '❌');
    console.log(`  ${icon} ${c.name.padEnd(12)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok && !c.warn).length;
  console.log(`\n${failed === 0 ? '全部通过 ✓' : `${failed} 项需处理`}\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}

/** 当前机器人的事件订阅诊断（useBotDir 已切到该 bot 的配置目录）。 */
async function checkEventSubscription(): Promise<Check> {
  const name = '事件订阅';
  try {
    const cfg = await loadConfig();
    if (!isComplete(cfg)) return { name, ok: true, warn: true, detail: '配置缺失，跳过检测' };
    const { app } = cfg.accounts;
    const secret = await resolveAppSecret(cfg);
    const d = await diagnoseEventSubscription(app.id, secret, app.tenant);
    const summary = summarizeEventDiagnosis(d);
    switch (d.state) {
      case 'ok': {
        const opt = d.missingOptional?.length ? `（可选事件未订阅：${d.missingOptional.join('、')}）` : '';
        return { name, ok: true, detail: `${summary}${opt}` };
      }
      case 'unchecked':
        // 优雅降级：多半是没开通「获取应用版本信息」scope —— 提示但不算失败。
        return { name, ok: true, warn: true, detail: `${summary}；开通 application:application.app_version:readonly 后可自动检测` };
      default:
        return { name, ok: false, detail: `${summary}；去 ${buildEventConfigUrl(app.id, app.tenant)} 配置后发布版本` };
    }
  } catch (err) {
    return { name, ok: true, warn: true, detail: `未能检测（${err instanceof Error ? err.message : String(err)}）` };
  }
}

function tryExec(cmd: string, args: string[]): string | null {
  try {
    // cross-spawn so a Windows `.cmd` shim (e.g. lark-cli.cmd) resolves instead
    // of being reported as "not found".
    const res = spawnProcessSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    return res.stdout.trim();
  } catch {
    return null;
  }
}
