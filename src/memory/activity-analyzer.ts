/**
 * Activity analyzer — pure functions to analyze user activity patterns.
 */

import type { ActivityRecord } from "./activity.js";

export type ActivityAnalysis = {
	isLateNight: boolean;
	isLongSession: boolean;
	sessionDurationMinutes: number;
	shouldAlert: boolean;
	suggestion: string | null;
};

const LATE_NIGHT_START = 0; // 00:00
const LATE_NIGHT_END = 6; // 06:00
const LONG_SESSION_MINUTES = 180; // 3 hours
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const MAX_ALERTS_PER_DAY = 3;

export function analyzeActivity(
	record: ActivityRecord,
	now: number = Date.now(),
): ActivityAnalysis {
	const currentHour = new Date(now).getHours();
	const isLateNight =
		currentHour >= LATE_NIGHT_START && currentHour < LATE_NIGHT_END;

	const sessionDurationMinutes = record.sessionStartAt
		? Math.floor((now - record.sessionStartAt) / 60_000)
		: 0;
	const isLongSession = sessionDurationMinutes >= LONG_SESSION_MINUTES;

	// Check cooldown and daily limit
	const cooledDown = now - record.lastAlertAt > ALERT_COOLDOWN_MS;
	const underDailyLimit = record.alertsToday < MAX_ALERTS_PER_DAY;
	const hasReason = isLateNight || isLongSession;

	const shouldAlert = hasReason && cooledDown && underDailyLimit;

	let suggestion: string | null = null;
	if (shouldAlert) {
		if (isLateNight && isLongSession) {
			suggestion = `형님, 벌써 새벽 ${currentHour}시인데 ${sessionDurationMinutes}분째 작업 중이십니다요... 제발 좀 쉬세요! 🙏`;
		} else if (isLateNight) {
			suggestion = `형님, 벌써 새벽 ${currentHour}시입니다요. 내일 하셔도 될 것 같은데... 좀 쉬시죠? 😴`;
		} else if (isLongSession) {
			suggestion = `형님, ${sessionDurationMinutes}분째 쉬지 않고 달리고 계십니다요. 잠깐 스트레칭이라도 하시죠! 💪`;
		}
	}

	return {
		isLateNight,
		isLongSession,
		sessionDurationMinutes,
		shouldAlert,
		suggestion,
	};
}
