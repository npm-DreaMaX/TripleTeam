import { availableParallelism, totalmem } from "node:os";

export type ResourceLane = "INTERACTIVE" | "CODING" | "LIGHT_CHECK" | "HEAVY_CHECK" | "INTEGRATION";

export interface LanePolicy {
	limit: number;
	weight: number;
	priority: number;
}

export interface ResourcePolicy {
	capacity: number;
	lanes: Readonly<Record<ResourceLane, LanePolicy>>;
}

interface Waiter {
	lane: ResourceLane;
	sequence: number;
	resolve: (release: () => void) => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export function defaultResourcePolicy(): ResourcePolicy {
	const cpu = Math.max(1, availableParallelism());
	const memoryGiB = Math.max(1, Math.floor(totalmem() / 1024 ** 3));
	const capacity = Math.max(2, Math.min(cpu, memoryGiB));
	const codingLimit = Math.max(1, Math.min(4, Math.floor(cpu / 2), Math.floor(memoryGiB / 3)));
	return {
		capacity,
		lanes: {
			INTERACTIVE: { limit: 2, weight: 1, priority: 100 },
			CODING: { limit: codingLimit, weight: Math.min(2, capacity), priority: 60 },
			LIGHT_CHECK: { limit: Math.max(1, Math.min(2, Math.floor(cpu / 2))), weight: 1, priority: 50 },
			HEAVY_CHECK: { limit: 1, weight: Math.max(1, Math.floor(capacity / 2)), priority: 40 },
			INTEGRATION: { limit: 1, weight: 1, priority: 80 },
		},
	};
}

export class LocalResourceGovernor {
	private readonly activeByLane: Record<ResourceLane, number> = {
		INTERACTIVE: 0,
		CODING: 0,
		LIGHT_CHECK: 0,
		HEAVY_CHECK: 0,
		INTEGRATION: 0,
	};
	private used = 0;
	private paused = false;
	private sequence = 0;
	private queue: Waiter[] = [];

	constructor(readonly policy: ResourcePolicy = defaultResourcePolicy()) {
		if (!Number.isInteger(policy.capacity) || policy.capacity < 1) {
			throw new Error("Resource capacity must be a positive integer");
		}
		for (const lane of Object.keys(policy.lanes) as ResourceLane[]) {
			const lanePolicy = policy.lanes[lane];
			if (lanePolicy.limit < 1 || lanePolicy.weight < 1 || lanePolicy.weight > policy.capacity) {
				throw new Error("Invalid resource policy for lane " + lane);
			}
		}
	}

	acquire(lane: ResourceLane, signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(new Error("Resource request aborted"));
		return new Promise<() => void>((resolve, reject) => {
			const waiter: Waiter = { lane, sequence: this.sequence++, resolve, reject, signal };
			if (signal) {
				waiter.onAbort = () => {
					const index = this.queue.indexOf(waiter);
					if (index >= 0) this.queue.splice(index, 1);
					reject(new Error("Resource request aborted"));
				};
				signal.addEventListener("abort", waiter.onAbort, { once: true });
			}
			this.queue.push(waiter);
			this.drain();
		});
	}

	async run<T>(lane: ResourceLane, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const release = await this.acquire(lane, signal);
		try {
			return await work();
		} finally {
			release();
		}
	}

	pause(): void {
		this.paused = true;
	}

	resume(): void {
		this.paused = false;
		this.drain();
	}

	snapshot(): {
		capacity: number;
		used: number;
		paused: boolean;
		activeByLane: Readonly<Record<ResourceLane, number>>;
		queued: number;
	} {
		return {
			capacity: this.policy.capacity,
			used: this.used,
			paused: this.paused,
			activeByLane: { ...this.activeByLane },
			queued: this.queue.length,
		};
	}

	private drain(): void {
		if (this.paused) return;
		this.queue.sort((left, right) => {
			const priority = this.policy.lanes[right.lane].priority - this.policy.lanes[left.lane].priority;
			return priority === 0 ? left.sequence - right.sequence : priority;
		});
		let madeProgress = true;
		while (madeProgress) {
			madeProgress = false;
			for (let index = 0; index < this.queue.length; index++) {
				const waiter = this.queue[index];
				if (!waiter || !this.canStart(waiter.lane)) continue;
				this.queue.splice(index, 1);
				waiter.signal?.removeEventListener("abort", waiter.onAbort as () => void);
				this.start(waiter);
				madeProgress = true;
				break;
			}
		}
	}

	private canStart(lane: ResourceLane): boolean {
		const lanePolicy = this.policy.lanes[lane];
		return this.activeByLane[lane] < lanePolicy.limit && this.used + lanePolicy.weight <= this.policy.capacity;
	}

	private start(waiter: Waiter): void {
		const lanePolicy = this.policy.lanes[waiter.lane];
		this.activeByLane[waiter.lane]++;
		this.used += lanePolicy.weight;
		let released = false;
		waiter.resolve(() => {
			if (released) return;
			released = true;
			this.activeByLane[waiter.lane]--;
			this.used -= lanePolicy.weight;
			this.drain();
		});
	}
}
