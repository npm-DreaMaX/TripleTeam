import type {
	ControlCatalog,
	CoordinationAssessment,
	ExplorationRecord,
	MessageRecord,
	TaskDefinition,
} from "./catalog.ts";

/** Keep ordinary mailbox traffic; exploration handoffs require an explicit matching
 * revision and baseline because an old report must not regain authority via chat. */
export function currentExplorationMessages(
	catalog: ControlCatalog,
	task: Pick<TaskDefinition, "revisionId">,
	baselineCommit: string,
	messages: MessageRecord[],
): MessageRecord[] {
	return messages.filter((message) => {
		if (message.senderKind !== "ATTEMPT") return true;
		const sender = catalog.getAttempt(message.senderId);
		if (sender.workflowFunction !== "EXPLORE") return true;
		try {
			const body = JSON.parse(message.body) as { taskRevisionId?: unknown; baselineCommit?: unknown };
			return body.taskRevisionId === task.revisionId && body.baselineCommit === baselineCommit;
		} catch {
			return false;
		}
	});
}

/** Records must already be restricted to the intended baseline. Failure is retryable;
 * an active or completed investigation is not. A revised task gets its own budget. */
export function pendingExplorationQuestions(
	task: Pick<TaskDefinition, "revisionId">,
	records: ExplorationRecord[],
	questions: CoordinationAssessment["explorationQuestions"],
	maxAttempts = 2,
): CoordinationAssessment["explorationQuestions"] {
	return questions.filter((question) => {
		const matching = records.filter(
			(record) =>
				record.taskRevisionId === task.revisionId &&
				record.investigationKey === question.key &&
				record.hypothesis === question.hypothesis,
		);
		return matching.length < maxAttempts && matching.every((record) => record.state === "FAILED");
	});
}
