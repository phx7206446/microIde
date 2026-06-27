/*---------------------------------------------------------------------------------------------
 *  Copyright (c) MicroIDE contributors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createInterface, type Interface } from 'readline';
import { Emitter, type Event } from '../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../log/common/log.js';
import type {
	IMicroClaudeJsonRpcRequest,
	IMicroClaudeJsonRpcResponse,
	IMicroClaudeSidecarEvent,
	MicroClaudeJsonRpcId,
	MicroClaudeMethod
} from '../common/microClaudeProtocol.js';
import {
	isMicroClaudeJsonRpcResponse,
	isMicroClaudeSidecarEvent
} from '../common/microClaudeProtocol.js';

export interface IMicroClaudeSidecarProcessOptions {
	readonly runtimePath: string;
	readonly entryPath: string;
	readonly sidecarRoot: string;
	readonly workspace?: string;
	readonly userDataDir?: string;
	readonly projectDataDir?: string;
	readonly engine?: 'lightweight' | 'microclaude';
	readonly microClaudeCliPath?: string;
	readonly microClaudeRuntimePath?: string;
	readonly configPath?: string;
	readonly defaultConfigPath?: string;
	readonly requestTimeoutMs?: number;
	readonly env?: NodeJS.ProcessEnv;
}

interface IPendingRequest {
	readonly id: MicroClaudeJsonRpcId;
	readonly method: MicroClaudeMethod;
	readonly timeout: ReturnType<typeof setTimeout>;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 3_000_000;

export class MicroClaudeSidecarProcess extends Disposable {
	private readonly _onDidEmitEvent = this._register(new Emitter<IMicroClaudeSidecarEvent>());
	readonly onDidEmitEvent: Event<IMicroClaudeSidecarEvent> = this._onDidEmitEvent.event;

	private child: ChildProcessWithoutNullStreams | undefined;
	private stdoutReader: Interface | undefined;
	private stderrReader: Interface | undefined;
	private nextRequestId = 1;
	private readonly pendingRequests = new Map<MicroClaudeJsonRpcId, IPendingRequest>();

	constructor(
		private readonly options: IMicroClaudeSidecarProcessOptions,
		private readonly logService: ILogService
	) {
		super();
		this._register(toDisposable(() => this.stop()));
	}

	async request<TResult>(method: MicroClaudeMethod, params: unknown = {}): Promise<TResult> {
		this.start();

		const child = this.child;
		if (!child || child.killed || child.stdin.destroyed) {
			throw new Error('microClaude sidecar is not writable');
		}

		const id = String(this.nextRequestId++);
		const request: IMicroClaudeJsonRpcRequest = {
			jsonrpc: '2.0',
			id,
			method,
			params
		};

		const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

		return new Promise<TResult>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new Error(`microClaude sidecar request timed out: ${method}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				id,
				method,
				timeout,
				resolve: value => resolve(value as TResult),
				reject
			});

			if (!child.stdin.write(`${JSON.stringify(request)}\n`)) {
				child.stdin.once('drain', () => this.logService.trace(`microClaude sidecar stdin drained after ${method}`));
			}
		});
	}

	start(): void {
		if (this.child && !this.child.killed) {
			return;
		}

		const args = this.buildArgs();
		this.logService.info(`Starting microClaude sidecar: ${this.options.runtimePath} ${args.join(' ')}`);

		const child = spawn(this.options.runtimePath, args, {
			cwd: this.options.sidecarRoot,
			stdio: ['pipe', 'pipe', 'pipe'],
			env: {
				...process.env,
				...this.options.env,
				ELECTRON_RUN_AS_NODE: undefined,
				FORCE_COLOR: '0',
				NO_COLOR: '1'
			},
			shell: false,
			windowsHide: true
		});

		this.child = child;
		this.stdoutReader = createInterface({ input: child.stdout });
		this.stderrReader = createInterface({ input: child.stderr });

		this.stdoutReader.on('line', line => this.handleStdoutLine(line));
		this.stderrReader.on('line', line => this.logService.warn(`[microClaude sidecar] ${line}`));

		child.on('error', error => {
			this.logService.error(error);
			this.rejectAll(error);
		});

		child.on('close', (code, signal) => {
			this.logService.info(`microClaude sidecar exited code=${code} signal=${signal ?? 'none'}`);
			this.child = undefined;
			this.stdoutReader?.close();
			this.stderrReader?.close();
			this.stdoutReader = undefined;
			this.stderrReader = undefined;
			this.rejectAll(new Error(`microClaude sidecar exited code=${code} signal=${signal ?? 'none'}`));
		});
	}

	stop(): void {
		const child = this.child;
		this.child = undefined;
		this.stdoutReader?.close();
		this.stderrReader?.close();
		this.stdoutReader = undefined;
		this.stderrReader = undefined;

		if (child && !child.killed) {
			child.kill();
		}

		this.rejectAll(new Error('microClaude sidecar stopped'));
	}

	private buildArgs(): string[] {
		const args = [
			this.options.entryPath
		];

		if (this.options.workspace) {
			args.push('--workspace', this.options.workspace);
		}
		if (this.options.userDataDir) {
			args.push('--user-data-dir', this.options.userDataDir);
		}
		if (this.options.projectDataDir) {
			args.push('--project-data-dir', this.options.projectDataDir);
		}
		if (this.options.engine) {
			args.push('--engine', this.options.engine);
		}
		if (this.options.microClaudeCliPath) {
			args.push('--microclaude-cli', this.options.microClaudeCliPath);
		}
		if (this.options.microClaudeRuntimePath) {
			args.push('--microclaude-runtime', this.options.microClaudeRuntimePath);
		}
		if (this.options.configPath) {
			args.push('--config', this.options.configPath);
		}
		if (this.options.defaultConfigPath) {
			args.push('--default-config', this.options.defaultConfigPath);
		}

		return args;
	}

	private handleStdoutLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.logService.warn(`[microClaude sidecar stdout] ${line}`);
			return;
		}

		if (isMicroClaudeSidecarEvent(parsed)) {
			this._onDidEmitEvent.fire(parsed);
			return;
		}

		if (isMicroClaudeJsonRpcResponse(parsed)) {
			this.handleResponse(parsed);
			return;
		}

		this.logService.warn(`Unexpected microClaude sidecar message: ${line}`);
	}

	private handleResponse(response: IMicroClaudeJsonRpcResponse): void {
		const pending = this.pendingRequests.get(response.id);
		if (!pending) {
			this.logService.warn(`Ignoring unmatched microClaude sidecar response: ${String(response.id)}`);
			return;
		}

		this.pendingRequests.delete(response.id);
		clearTimeout(pending.timeout);

		if (response.error) {
			pending.reject(new Error(response.error.message));
			return;
		}

		pending.resolve(response.result);
	}

	private rejectAll(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			clearTimeout(pending.timeout);
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}
}
