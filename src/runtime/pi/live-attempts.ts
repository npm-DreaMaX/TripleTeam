import type { MessageKind, MessageRecipientKind } from "../../control/kernel.ts";
import type { PiWorkerController } from "./launcher.ts";

export interface LiveMessageDelivery {
	messageId: string;
	senderKind: "USER" | "SYSTEM" | "ATTEMPT";
	senderId: string;
	recipientKind: MessageRecipientKind;
	recipientId: string;
	kind: MessageKind;
	body: string;
}

interface LiveAttempt {
	attemptId: string;
	taskId: string | null;
	worker: PiWorkerController;
}

export class LiveAttemptRegistry {
	private readonly byAttempt = new Map<string, LiveAttempt>();
	private readonly byTask = new Map<string, string>();

	register(attemptId: string, taskId: string | null, worker: PiWorkerController): () => void {
		if (this.byAttempt.has(attemptId)) throw new Error("Attempt already has a live Pi controller");
		if (taskId && this.byTask.has(taskId)) throw new Error("Task already has a live Pi controller");
		const live = { attemptId, taskId, worker };
		this.byAttempt.set(attemptId, live);
		if (taskId) this.byTask.set(taskId, attemptId);
		return () => {
			if (this.byAttempt.get(attemptId) !== live) return;
			this.byAttempt.delete(attemptId);
			if (taskId && this.byTask.get(taskId) === attemptId) this.byTask.delete(taskId);
		};
	}

	async deliver(message: LiveMessageDelivery): Promise<boolean> {
		const attemptId =
			message.recipientKind === "ATTEMPT"
				? message.recipientId
				: message.recipientKind === "TASK"
					? this.byTask.get(message.recipientId)
					: undefined;
		if (!attemptId) return false;
		const target = this.byAttempt.get(attemptId);
		if (!target) return false;
		await target.worker.followUp(
			`[Durable orchestrator message ${message.messageId}]\nFrom: ${message.senderKind}:${message.senderId}\nKind: ${message.kind}\n${message.body}\n\nUse orchestrator_context to inspect authoritative task state and the durable message record before acting.`,
		);
		return true;
	}

	async abort(attemptId: string): Promise<boolean> {
		const target = this.byAttempt.get(attemptId);
		if (!target) return false;
		await target.worker.abort();
		return true;
	}
}
