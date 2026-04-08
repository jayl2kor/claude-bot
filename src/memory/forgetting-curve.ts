/**
 * @deprecated This module is a thin re-export shim.
 * All forgetting curve logic has been consolidated into `./decay.ts`.
 * Import directly from `./decay.js` instead.
 */
export {
	DECAY_LAMBDA,
	INITIAL_STRENGTH,
	REINFORCE_INCREMENT,
	FORGETTING_THRESHOLD,
	computeDecayedStrength,
	computeReinforcedStrength,
	isForgotten,
} from "./decay.js";
