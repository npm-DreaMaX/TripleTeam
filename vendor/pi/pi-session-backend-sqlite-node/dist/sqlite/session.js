/** SQLite-specific open-session lifecycle wrapper. */
export class SqliteOpenSession {
    metadata;
    idGenerator;
    session;
    onClose;
    admitted = new Set();
    closedError = new Error("Session is closed");
    state = "open";
    closePromise;
    constructor(session, options) {
        this.session = session;
        this.metadata = session.metadata;
        this.idGenerator = session.idGenerator;
        this.onClose = options.onClose;
    }
    async beginMutation(context) {
        let resolveFinished;
        const finished = new Promise((resolve) => {
            resolveFinished = resolve;
        });
        this.admitted.add(finished);
        let source;
        try {
            source = await this.admit(() => this.session.beginMutation(context));
        }
        catch (error) {
            this.admitted.delete(finished);
            resolveFinished();
            throw error;
        }
        if (this.state !== "open") {
            await source.end(context);
            this.admitted.delete(finished);
            resolveFinished();
            throw this.closedError;
        }
        let ended = false;
        return {
            commit: (writes, commitContext) => source.commit(writes, commitContext),
            end: async (endContext) => {
                try {
                    await source.end(endContext);
                }
                finally {
                    if (!ended) {
                        ended = true;
                        this.admitted.delete(finished);
                        resolveFinished();
                    }
                }
            },
            getEntries: (ids, readContext) => source.getEntries(ids, readContext),
            getStats: (readContext) => source.getStats(readContext),
            getValue: (address, readContext) => source.getValue(address, readContext),
            scanValues: (prefix, readContext) => source.scanValues(prefix, readContext),
            readList: (address, options, readContext) => source.readList(address, options, readContext),
            scanBranch: (query, readContext) => source.scanBranch(query, readContext),
        };
    }
    mutate(mutation, context) {
        return this.admit(() => this.session.mutate((mutator, mutationContext) => {
            if (this.state !== "open")
                throw this.closedError;
            return mutation(mutator, mutationContext);
        }, context));
    }
    getEntries(ids, context) {
        return this.admit(() => this.session.getEntries(ids, context));
    }
    getEntry(id, context) {
        return this.admit(() => this.session.getEntry(id, context));
    }
    getValue(address, context) {
        return this.admit(() => this.session.getValue(address, context));
    }
    scanValues(prefix, context) {
        return this.admit(() => this.session.scanValues(prefix, context));
    }
    readList(address, options, context) {
        return this.admit(() => this.session.readList(address, options, context));
    }
    scanBranch(query, context) {
        return this.admit(() => this.session.scanBranch(query, context));
    }
    getStats(context) {
        return this.admit(() => this.session.getStats(context));
    }
    getName(context) {
        return this.admit(() => this.session.getName(context));
    }
    getLabel(targetId, context) {
        return this.admit(() => this.session.getLabel(targetId, context));
    }
    findEntries(query, context) {
        return this.admit(() => this.session.findEntries(query, context));
    }
    findEntry(query, context) {
        return this.admit(() => this.session.findEntry(query, context));
    }
    async branch(name, context) {
        const branch = await this.admit(() => this.session.branch(name, context));
        return branch === undefined ? undefined : this.wrapBranch(branch);
    }
    async createBranch(name, at, context) {
        return this.wrapBranch(await this.admit(() => this.session.createBranch(name, at, context)));
    }
    setValue(address, next, context) {
        return this.admit(() => this.session.setValue(address, next, context));
    }
    deleteValue(address, context) {
        return this.admit(() => this.session.deleteValue(address, context));
    }
    appendList(address, element, context) {
        return this.admit(() => this.session.appendList(address, element, context));
    }
    deleteList(address, context) {
        return this.admit(() => this.session.deleteList(address, context));
    }
    setName(name, context) {
        return this.admit(() => this.session.setName(name, context));
    }
    setLabel(targetId, label, context) {
        return this.admit(() => this.session.setLabel(targetId, label, context));
    }
    close(context) {
        if (this.closePromise !== undefined)
            return this.closePromise;
        this.state = "closing";
        this.closePromise = Promise.allSettled([...this.admitted])
            .then(() => this.session.close(context))
            .finally(() => {
            this.state = "closed";
            this.onClose();
        });
        return this.closePromise;
    }
    wrapBranch(branch) {
        return {
            name: branch.name,
            getTipId: (context) => this.admit(() => branch.getTipId(context)),
            findEntries: (query, context) => this.admit(() => branch.findEntries(query, context)),
            findEntry: (query, context) => this.admit(() => branch.findEntry(query, context)),
            appendMessage: (message, context) => this.admit(() => branch.appendMessage(message, context)),
            appendCustomEntry: (customType, data, context) => this.admit(() => branch.appendCustomEntry(customType, data, context)),
        };
    }
    admit(operation) {
        if (this.state !== "open")
            return Promise.reject(this.closedError);
        let result;
        try {
            result = operation();
        }
        catch (error) {
            result = Promise.reject(error);
        }
        this.admitted.add(result);
        void result.then(() => this.admitted.delete(result), () => this.admitted.delete(result));
        return result;
    }
}
//# sourceMappingURL=session.js.map