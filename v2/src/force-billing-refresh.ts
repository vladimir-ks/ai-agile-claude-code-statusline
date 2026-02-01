#!/usr/bin/env bun
/**
 * Force Billing Refresh - Bypass daemon lock and fetch fresh billing data
 * Use this when billing data is stale and daemons can't acquire lock
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, renameSync, unlinkSync, existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

const execAsync = promisify(exec);
const sharedBillingPath = `${homedir()}/.claude/session-health/billing-shared.json`;
const lockPath = `${homedir()}/.claude/.ccusage.lock`;
const subscriptionPath = `${homedir()}/.claude/config/subscription.yaml`;

// Day name to number (0=Sunday, 1=Monday, ..., 6=Saturday)
const DAY_MAP: Record<string, number> = {
  'sunday': 0, 'sun': 0,
  'monday': 1, 'mon': 1,
  'tuesday': 2, 'tue': 2,
  'wednesday': 3, 'wed': 3,
  'thursday': 4, 'thu': 4,
  'friday': 5, 'fri': 5,
  'saturday': 6, 'sat': 6
};

function readSubscription(): { resetDay: string; resetDayNum: number; resetHour: number; usedPercent: number } {
  const defaults = { resetDay: 'Sat', resetDayNum: 6, resetHour: 0, usedPercent: 0 };

  try {
    if (!existsSync(subscriptionPath)) return defaults;
    const content = readFileSync(subscriptionPath, 'utf-8');
    const parsed = parseYaml(content);

    if (!parsed?.weekly) return defaults;

    const resetDayStr = String(parsed.weekly.resetDay || 'Saturday').toLowerCase();
    const resetDayNum = DAY_MAP[resetDayStr] ?? 6;
    const resetDay = (parsed.weekly.resetDay || 'Saturday').substring(0, 3);

    return {
      resetDay,
      resetDayNum,
      resetHour: Number(parsed.weekly.resetHour) || 0,
      usedPercent: Number(parsed.weekly.usedPercent) || 0
    };
  } catch {
    return defaults;
  }
}

async function forceBillingRefresh() {
  console.log('=== Force Billing Refresh ===\n');

  // Step 1: Kill any data-daemon processes to stop lock contention
  console.log('Killing any running data-daemon processes...');
  try {
    await execAsync('pkill -f "data-daemon" 2>/dev/null || true');
  } catch {}
  await new Promise(r => setTimeout(r, 1000));

  // Step 2: Remove stale locks (up to 30 seconds of waiting)
  for (let attempt = 0; attempt < 10; attempt++) {
    if (!existsSync(lockPath)) break;

    try {
      const lockPid = parseInt(require('fs').readFileSync(lockPath, 'utf-8').trim());
      try {
        process.kill(lockPid, 0);
        console.log(`Attempt ${attempt + 1}: Lock held by PID ${lockPid} (alive). Waiting 3s...`);
        await new Promise(r => setTimeout(r, 3000));
      } catch {
        console.log(`Lock held by dead process ${lockPid}. Removing...`);
        unlinkSync(lockPath);
        break;
      }
    } catch (e) {
      console.log('Lock file corrupted. Removing...');
      try { unlinkSync(lockPath); } catch {}
      break;
    }
  }

  // Step 3: Create our lock (with retry)
  console.log('\nAcquiring lock...');
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      console.log(`Lock acquired (PID ${process.pid})`);
      break;
    } catch (e: any) {
      if (e.code === 'EEXIST' && attempt < 4) {
        console.log(`Lock exists, waiting 2s... (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, 2000));
        // Try to remove stale lock
        try {
          const lockPid = parseInt(require('fs').readFileSync(lockPath, 'utf-8').trim());
          try {
            process.kill(lockPid, 0);
            // Process alive, continue waiting
          } catch {
            // Process dead, remove lock
            unlinkSync(lockPath);
          }
        } catch {}
      } else {
        throw e;
      }
    }
  }

  try {
    // Step 3: Run ccusage
    console.log('\nRunning ccusage...');
    const { stdout } = await execAsync('ccusage blocks --json --active', {
      timeout: 60000,
      maxBuffer: 1024 * 1024
    });

    const data = JSON.parse(stdout);
    const activeBlock = data.blocks?.find((b: any) => b.isActive === true);

    if (!activeBlock) {
      console.log('No active block found!');
      return;
    }

    // Step 4: Calculate billing info
    const costUSD = activeBlock.costUSD || 0;
    const costPerHour = activeBlock.burnRate?.costPerHour || 0;
    const totalTokens = activeBlock.totalTokens || 0;
    const tokensPerMinute = activeBlock.burnRate?.tokensPerMinute || null;

    const startTime = new Date(activeBlock.startTime);
    const endTime = new Date(activeBlock.endTime);
    const now = new Date();

    const totalMs = endTime.getTime() - startTime.getTime();
    const elapsedMs = now.getTime() - startTime.getTime();
    const remainingMs = Math.max(0, endTime.getTime() - now.getTime());

    const percentageUsed = totalMs > 0 ? Math.min(100, Math.floor((elapsedMs / totalMs) * 100)) : 0;
    const hoursLeft = Math.floor(remainingMs / (1000 * 60 * 60));
    const minutesLeft = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
    const budgetRemaining = hoursLeft * 60 + minutesLeft;
    const resetTime = `${String(endTime.getUTCHours()).padStart(2, '0')}:${String(endTime.getUTCMinutes()).padStart(2, '0')}`;

    // Calculate weekly budget - read from subscription.yaml
    const subscription = readSubscription();
    const dayOfWeek = now.getUTCDay(); // 0=Sunday, 1=Monday, ...

    // Calculate days until reset day
    let daysUntilReset = subscription.resetDayNum - dayOfWeek;
    if (daysUntilReset < 0) {
      daysUntilReset += 7;
    } else if (daysUntilReset === 0) {
      // Same day - check if reset already happened
      if (now.getUTCHours() >= subscription.resetHour) {
        daysUntilReset = 7; // Next week
      }
    }

    const hoursUntilReset = (daysUntilReset * 24) - now.getUTCHours() + subscription.resetHour - (now.getUTCMinutes() / 60);

    // Weekly reset day name from subscription
    const weeklyResetDay = subscription.resetDay;
    // Use the user-provided weekly usage percentage
    const weekProgressPercent = subscription.usedPercent;

    const billing = {
      costToday: costUSD,
      burnRatePerHour: costPerHour,
      budgetRemaining,
      budgetPercentUsed: percentageUsed,
      resetTime,
      totalTokens,
      tokensPerMinute,
      isFresh: true,
      lastFetched: Date.now(),
      // Weekly quota fields
      weeklyBudgetRemaining: Math.floor(Math.max(0, hoursUntilReset)), // Hours until reset
      weeklyBudgetPercentUsed: weekProgressPercent, // Percent of week elapsed
      weeklyResetDay: weeklyResetDay
    };

    // Step 5: Write to shared cache
    console.log('\nWriting to billing-shared.json...');
    const tempPath = `${sharedBillingPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(billing, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tempPath, sharedBillingPath);

    console.log('\n=== SUCCESS! Fresh Billing Data ===');
    console.log(`Cost Today: $${costUSD.toFixed(2)}`);
    console.log(`Burn Rate: $${costPerHour.toFixed(2)}/h`);
    console.log(`Remaining: ${hoursLeft}h ${minutesLeft}m (${budgetRemaining} minutes)`);
    console.log(`Percent Used: ${percentageUsed}%`);
    console.log(`Reset Time: ${resetTime} UTC`);
    console.log(`Total Tokens: ${totalTokens.toLocaleString()}`);
    console.log(`\nData written to: ${sharedBillingPath}`);

  } finally {
    // Step 6: Release lock
    console.log('\nReleasing lock...');
    try { unlinkSync(lockPath); } catch {}
  }
}

forceBillingRefresh().catch(console.error);
