/** Classifies only Pi's public assistant error metadata; provider response bodies are never retained. */
export class PiProviderUnavailableError extends Error {
	constructor(readonly category: "BILLING" | "AUTHENTICATION" | "PERMISSION") {
		super(
			category === "BILLING"
				? "Model provider billing/quota is unavailable (402 or insufficient quota). Restore the account balance or quota before continuing."
				: category === "AUTHENTICATION"
					? "Model provider authentication failed (401 or invalid API key). Correct the provider credentials before continuing."
					: "Model provider denied access (403). Restore model/API permissions before continuing.",
		);
		this.name = "PiProviderUnavailableError";
	}
}

export function permanentProviderError(message: string | undefined): PiProviderUnavailableError | undefined {
	if (!message) return;
	if (
		/(?:^|\bHTTP\s+|\bstatus[ :=]+)402\b|insufficient[_ ](?:balance|quota|credits?)|credit balance.*(?:low|exhausted)|exceeded your current quota/i.test(
			message,
		)
	)
		return new PiProviderUnavailableError("BILLING");
	if (/(?:^|\bHTTP\s+|\bstatus[ :=]+)401\b|invalid[_ ]api[_ ]key|invalid authentication/i.test(message))
		return new PiProviderUnavailableError("AUTHENTICATION");
	if (/(?:^|\bHTTP\s+|\bstatus[ :=]+)403\b/i.test(message)) return new PiProviderUnavailableError("PERMISSION");
}
