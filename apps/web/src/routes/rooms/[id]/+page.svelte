<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		connect,
		decode,
		ensurePublished,
		keysOf,
		listRooms,
		readTranscript,
		report,
		send,
		setBlocked,
		ServerFrame,
		type PublicKeys,
		type ReadMessage,
	} from '#lib/api/rooms.ts';
	import type { Keyring } from '#lib/crypto/keys.ts';
	import { SITE_NAME } from '#lib/config.ts';
	import Alert from '#lib/ui/Alert.svelte';
	import Badge from '#lib/ui/Badge.svelte';
	import Button from '#lib/ui/Button.svelte';
	import Card from '#lib/ui/Card.svelte';
	import * as v from 'valibot';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	let messages = $state<ReadMessage[]>([]);
	let devices = $state<PublicKeys[]>([]);
	let otherName = $state('');
	let otherId = $state('');
	let myFingerprint = $state('');
	let draft = $state('');
	let status = $state<'connecting' | 'reconnecting' | 'live' | 'offline'>('connecting');
	let error = $state('');
	let blocked = $state(false);
	let showDetail = $state(false);
	let waitingForThem = $state(false);
	// What has been sent but not yet echoed back by the server. A socket can look open for a
	// second after the other end is gone, so "sent" is not "stored" until the echo arrives.
	let pending = $state<{ id: string; text: string }[]>([]);

	let keyring: Keyring | null = null;
	let socket: WebSocket | null = null;
	let transcript: HTMLElement | undefined = $state();
	let closed = false;
	let attempt = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;

	const theirDevices = $derived(devices.filter((device) => device.userId === otherId));
	const myDevices = $derived(devices.filter((device) => device.userId === data.user.id));
	// Messages that predate this browser are a fact about the device, not about any one message,
	// so they are counted once and reported once instead of repeating down the transcript.
	const older = $derived(messages.filter((message) => message.predatesDevice).length);
	const readable = $derived(messages.filter((message) => !message.predatesDevice));

	/** Keeps the newest message in view, the way every conversation is read. */
	async function scrollToEnd(): Promise<void> {
		await tick();
		transcript?.scrollTo({ top: transcript.scrollHeight });
	}

	/** Re-reads both people's devices. Called at open, and whenever the server says the list moved. */
	async function refreshDevices(): Promise<void> {
		const [theirs, mine] = await Promise.all([keysOf(otherId), keysOf(data.user.id)]);
		devices = [...theirs, ...mine];
		waitingForThem = theirs.length === 0;
	}

	/**
	 * Refreshes the device list without letting a failure escape.
	 *
	 * Called from the reconnect path, where the API is usually the thing that is down. An
	 * unhandled rejection there would kill the retry chain and leave the reader stranded on a
	 * page that says "reconnecting" forever — the exact failure the retry exists to prevent.
	 *
	 * @returns Nothing. A refresh that fails leaves the previous list in place, which is the right
	 *   list right up until somebody adds a device.
	 */
	async function refreshDevicesQuietly(): Promise<void> {
		try {
			await refreshDevices();
		} catch {
			// Keep whatever was known. The socket attempt below is the thing that matters.
		}
	}

	/**
	 * Opens the socket, and keeps opening it.
	 *
	 * A socket dies for ordinary reasons — a laptop sleeps, a deploy restarts the server, a train
	 * goes into a tunnel — and a chat that answers that by disabling itself until the reader
	 * thinks to reload is broken in the way that is hardest to report. Backoff so a server that is
	 * genuinely down is not hammered, capped so recovery stays quick.
	 */
	async function openSocket(): Promise<void> {
		if (closed || !keyring) return;

		status = attempt === 0 ? 'connecting' : 'reconnecting';

		try {
			socket = await connect(data.roomId);
		} catch {
			// The ticket call fails while the API is down, which is exactly when this must keep
			// trying rather than give up.
			scheduleRetry();
			return;
		}

		socket.addEventListener('open', () => {
			attempt = 0;
			status = 'live';
		});

		socket.addEventListener('close', () => {
			if (closed) return;
			status = 'offline';
			scheduleRetry();
		});

		socket.addEventListener('message', async (event) => {
			// A frame that is not JSON, or not one of ours, is dropped: a stray frame must not kill the
			// handler.
			let raw: unknown;
			try {
				raw = JSON.parse(String(event.data));
			} catch {
				console.warn('Ignoring a socket frame that is not JSON');
				return;
			}

			const result = v.safeParse(ServerFrame, raw);
			if (!result.success) {
				console.warn('Ignoring an unrecognised socket frame', result.issues[0]?.message);
				return;
			}
			const frame = result.output;

			// Somebody opened the app on another browser since this page loaded. Pick up their new
			// device and let the reader send again — the message was not stored.
			if (frame.type === 'stale_devices') {
				await refreshDevices();
				error = `${otherName} just opened this on another device. Send that again.`;
				return;
			}

			if (frame.type === 'error') {
				error = frame.detail;
				return;
			}

			if (!keyring) return;
			const live = frame.message;

			// The sender sees their own message come back through the socket, which is what
			// reconciles the optimistic copy against the id the server actually stored.
			if (messages.some((existing) => existing.id === live.id)) return;

			const read = await decode(live, keyring, devices, myFingerprint);

			// The echo of something this device sent: drop the optimistic copy in favour of it.
			if (read.senderId === data.user.id && read.text !== null) {
				pending = pending.filter((item) => item.text !== read.text);
			}

			messages = [...messages, read];
			await scrollToEnd();
		});
	}

	/** Waits, then tries again. Doubling, capped at ten seconds. */
	function scheduleRetry(): void {
		if (closed) return;

		attempt += 1;
		clearTimeout(retry);

		retry = setTimeout(
			() => {
				// The other side may have added a device while this client was away, and a reconnect is
				// the natural moment to find out — before the reader types rather than after.
				void refreshDevices().then(openSocket);
			},
			Math.min(1000 * 2 ** (attempt - 1), 10_000),
		);
	}

	onMount(() => {
		(async () => {
			try {
				const published = await ensurePublished();
				keyring = published.keyring;
				myFingerprint = published.fingerprint;

				// The inbox knows who the other person is; the room endpoint deliberately does not
				// hand that out separately.
				const room = (await listRooms()).find((entry) => entry.id === data.roomId);
				if (!room) throw new Error('That conversation is not yours.');

				otherName = room.otherName;
				otherId = room.otherId;
				await refreshDevices();

				messages = await readTranscript(data.roomId, keyring, myFingerprint, devices);
				await scrollToEnd();

				await openSocket();
			} catch (cause) {
				error = cause instanceof Error ? cause.message : 'Could not open that conversation.';
				status = 'offline';
			}
		})();

		return () => {
			closed = true;
			clearTimeout(retry);
			socket?.close();
		};
	});

	/** Seals the draft for every device in the conversation and sends it. */
	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();

		const text = draft.trim();
		if (!text || !socket || !keyring) return;

		if (socket.readyState !== WebSocket.OPEN) {
			error = 'Not connected yet. Your message is still here — try again in a moment.';
			return;
		}

		error = '';

		const ticket = crypto.randomUUID();
		pending = [...pending, { id: ticket, text }];
		draft = '';
		await scrollToEnd();

		try {
			await send(socket, keyring, myFingerprint, devices, text);
		} catch {
			giveBack(ticket, 'Could not send that.');
			return;
		}

		// A socket can accept bytes into a connection whose other end is already gone. The echo is
		// the only proof the message was stored, so an unanswered send hands the text back rather
		// than leaving the reader believing they said something they did not.
		setTimeout(() => giveBack(ticket, 'That did not reach the server. Try again.'), 8000);
	}

	/**
	 * Returns an unconfirmed message to the compose box.
	 *
	 * @param ticket Which pending message.
	 * @param reason What to tell the reader.
	 */
	function giveBack(ticket: string, reason: string): void {
		const stuck = pending.find((item) => item.id === ticket);
		if (!stuck) return;

		pending = pending.filter((item) => item.id !== ticket);
		draft = draft === '' ? stuck.text : `${stuck.text}\n${draft}`;
		error = reason;
	}

	/** Stops the conversation, or lets it resume. */
	async function toggleBlock(): Promise<void> {
		await setBlocked(data.roomId, !blocked);
		blocked = !blocked;
	}

	/** Reports one message, disclosing what it said. */
	async function flag(message: ReadMessage): Promise<void> {
		const reason = prompt('What is wrong with this message?');
		if (!reason) return;

		await report(data.roomId, message.id, reason, message.text ?? '');
		alert('Reported. A moderator can check the signature against what you disclosed.');
	}

	/**
	 * Formats a message timestamp.
	 *
	 * @param iso ISO-8601 timestamp.
	 * @returns A short time.
	 */
	const at = (iso: string): string =>
		new Date(iso).toLocaleString(undefined, {
			day: 'numeric',
			month: 'short',
			hour: '2-digit',
			minute: '2-digit',
		});
</script>

<svelte:head>
	<title>{otherName || 'Conversation'} · {SITE_NAME}</title>
	<meta name="robots" content="noindex" />
</svelte:head>

<Button variant="ghost" size="sm" href="/rooms" class="-ml-3">← Messages</Button>

<div class="mt-4 flex flex-wrap items-center gap-2">
	<h1 class="text-xl font-semibold tracking-tight">{otherName || 'Conversation'}</h1>

	<div class="ml-auto flex gap-2">
		<Button variant="ghost" size="sm" onclick={() => (showDetail = !showDetail)}>Details</Button>
		<Button variant="ghost" size="sm" onclick={toggleBlock}>
			{blocked ? 'Unblock' : 'Block'}
		</Button>
	</div>
</div>

{#if showDetail}
	<Card class="mt-3 p-4 text-sm">
		<p class="text-muted">
			Messages here are encrypted on your device. This site relays what it cannot read.
		</p>

		<h2 class="mt-4 text-xs font-semibold tracking-wide uppercase">Safety codes</h2>
		<p class="mt-1 text-xs text-muted">
			Read these to each other in person or on a call. If they match on both screens, nobody is in
			the middle.
		</p>

		<dl class="mt-2 flex flex-col gap-1 font-mono text-xs">
			<div class="flex flex-wrap gap-2">
				<dt class="w-28 shrink-0 font-sans text-muted">You</dt>
				<dd>{myFingerprint}</dd>
			</div>
			{#each theirDevices as device (device.fingerprint)}
				<div class="flex flex-wrap gap-2">
					<dt class="w-28 shrink-0 font-sans text-muted">{otherName}</dt>
					<dd>{device.fingerprint}</dd>
				</div>
			{/each}
		</dl>

		<p class="mt-3 text-xs text-muted">
			{otherName} reads on {theirDevices.length}
			{theirDevices.length === 1 ? 'device' : 'devices'}; you have {myDevices.length}. Every message
			is sealed for all of them.
		</p>
	</Card>
{/if}

{#if waitingForThem}
	<Alert variant="info" class="mt-3">
		{otherName} has not opened this site on any device yet, so there is nothing to encrypt to. The conversation
		is here waiting — come back once they have signed in.
	</Alert>
{/if}

{#if error}
	<Alert variant="warning" class="mt-3" assertive>{error}</Alert>
{/if}

<Card class="mt-4 flex h-[28rem] flex-col p-0">
	<div bind:this={transcript} class="flex-1 overflow-y-auto p-4">
		{#if older > 0}
			<p class="mb-4 text-center text-xs text-muted">
				{older}
				{older === 1 ? 'earlier message stays' : 'earlier messages stay'} on the device that received
				{older === 1 ? 'it' : 'them'}. Encryption is what makes that true.
			</p>
		{/if}

		{#if readable.length === 0 && pending.length === 0}
			<p class="py-12 text-center text-sm text-muted">
				{older > 0 ? 'Nothing new here yet.' : 'Nothing said yet.'}
			</p>
		{:else}
			<ul class="flex flex-col gap-3">
				{#each readable as message (message.id)}
					{@const mine = message.senderId === data.user.id}
					<li class="flex flex-col gap-1" class:items-end={mine}>
						<div
							class="max-w-[80%] rounded-app px-3 py-2 text-sm"
							class:bg-primary={mine}
							class:text-primary-fg={mine}
							class:bg-surface-2={!mine}
						>
							{#if message.text === null}
								<span class="italic opacity-70">This message will not open.</span>
							{:else}
								<span class="whitespace-pre-line">{message.text}</span>
							{/if}
						</div>

						<div class="flex items-center gap-2 text-xs text-muted">
							<span>{at(message.createdAt)}</span>

							{#if !mine && message.authenticity === 'failed'}
								<Badge variant="accent">signature does not match</Badge>
							{/if}

							{#if !mine && message.text !== null}
								<button
									type="button"
									onclick={() => flag(message)}
									class="underline underline-offset-2 hover:text-text"
								>
									report
								</button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}

		{#if pending.length > 0}
			<ul class="mt-3 flex flex-col gap-3">
				{#each pending as item (item.id)}
					<li class="flex flex-col items-end gap-1">
						<div class="max-w-[80%] rounded-app bg-primary/60 px-3 py-2 text-sm text-primary-fg">
							<span class="whitespace-pre-line">{item.text}</span>
						</div>
						<span class="text-xs text-muted">sending…</span>
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<div class="border-t border-border">
		{#if status !== 'live' && !blocked && !waitingForThem}
			<!-- Typing keeps working while the connection comes back; only sending waits. -->
			<p class="px-3 pt-2 text-xs text-muted">
				{status === 'offline' ? 'Reconnecting…' : 'Connecting…'}
			</p>
		{/if}

		<form class="flex gap-2 p-3" onsubmit={submit}>
			<input
				bind:value={draft}
				placeholder={blocked
					? 'You blocked this conversation.'
					: waitingForThem
						? `Waiting for ${otherName} to sign in`
						: 'Write a message'}
				disabled={blocked || waitingForThem}
				maxlength="4000"
				class="h-10 flex-1 rounded-app border border-border bg-surface px-3 text-sm text-text placeholder:text-muted disabled:opacity-60"
			/>
			<Button
				type="submit"
				size="sm"
				disabled={status !== 'live' || blocked || waitingForThem || !draft.trim()}
			>
				Send
			</Button>
		</form>
	</div>
</Card>
