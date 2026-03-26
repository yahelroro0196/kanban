import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useLinkedBacklogTaskActions } from "@/hooks/use-linked-backlog-task-actions";
import { getDetailTerminalTaskId } from "@/hooks/use-terminal-panels";
import type { BoardCard, BoardData, BoardDependency } from "@/types";

const trackTaskDependencyCreatedMock = vi.hoisted(() => vi.fn());
const trackTasksAutoStartedFromDependencyMock = vi.hoisted(() => vi.fn());

vi.mock("@/telemetry/events", () => ({
	trackTaskDependencyCreated: trackTaskDependencyCreatedMock,
	trackTasksAutoStartedFromDependency: trackTasksAutoStartedFromDependencyMock,
}));

function createTask(taskId: string, prompt: string, createdAt: number): BoardCard {
	return {
		id: taskId,
		prompt,
		startInPlanMode: false,
		autoReviewEnabled: false,
		autoReviewMode: "commit",
		baseRef: "main",
		createdAt,
		updatedAt: createdAt,
	};
}

function createBoard(dependencies: BoardDependency[] = []): BoardData {
	return {
		columns: [
			{
				id: "backlog",
				title: "Backlog",
				cards: [createTask("task-1", "Backlog task", 1), createTask("task-3", "Second backlog task", 3)],
			},
			{ id: "in_progress", title: "In Progress", cards: [] },
			{
				id: "review",
				title: "Review",
				cards: [createTask("task-2", "Review task", 2)],
			},
			{ id: "trash", title: "Trash", cards: [] },
		],
		dependencies,
	};
}

interface HookSnapshot {
	board: BoardData;
	handleCreateDependency: (fromTaskId: string, toTaskId: string) => void;
	confirmMoveTaskToTrash: (task: BoardCard, currentBoard?: BoardData) => Promise<void>;
	requestMoveTaskToTrash: (
		taskId: string,
		fromColumnId: "backlog" | "in_progress" | "review" | "trash",
	) => Promise<void>;
}

function HookHarness({
	boardFactory,
	onSnapshot,
	requestAutoStartTasks,
	stopTaskSession,
	cleanupTaskWorkspace,
}: {
	boardFactory?: () => BoardData;
	onSnapshot: (snapshot: HookSnapshot) => void;
	requestAutoStartTasks?: (requestedTaskIds?: string[]) => Promise<string[]>;
	stopTaskSession?: (taskId: string) => Promise<void>;
	cleanupTaskWorkspace?: (taskId: string) => Promise<unknown>;
}): null {
	const [board, setBoard] = useState<BoardData>(() => (boardFactory ? boardFactory() : createBoard()));
	const actions = useLinkedBacklogTaskActions({
		board,
		setBoard,
		setSelectedTaskId: () => {},
		stopTaskSession: stopTaskSession ?? (async () => {}),
		cleanupTaskWorkspace: cleanupTaskWorkspace ?? (async () => null),
		requestAutoStartTasks: requestAutoStartTasks ?? (async () => []),
	});

	useEffect(() => {
		onSnapshot({
			board,
			handleCreateDependency: actions.handleCreateDependency,
			confirmMoveTaskToTrash: actions.confirmMoveTaskToTrash,
			requestMoveTaskToTrash: actions.requestMoveTaskToTrash,
		});
	}, [actions.confirmMoveTaskToTrash, actions.handleCreateDependency, actions.requestMoveTaskToTrash, board, onSnapshot]);

	return null;
}

describe("useLinkedBacklogTaskActions", () => {
	let container: HTMLDivElement;
	let root: Root;
	let previousActEnvironment: boolean | undefined;

	beforeEach(() => {
		trackTaskDependencyCreatedMock.mockReset();
		trackTasksAutoStartedFromDependencyMock.mockReset();
		previousActEnvironment = (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
			.IS_REACT_ACT_ENVIRONMENT;
		(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});

	afterEach(() => {
		act(() => {
			root.unmount();
		});
		container.remove();
		if (previousActEnvironment === undefined) {
			delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
		} else {
			(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
				previousActEnvironment;
		}
	});

	it("tracks dependency creation after a valid link is added", async () => {
		let latestSnapshot: HookSnapshot | null = null;

		await act(async () => {
			root.render(
				<HookHarness
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;

		await act(async () => {
			initialSnapshot.handleCreateDependency("task-1", "task-2");
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an updated hook snapshot.");
		}
		const snapshot = latestSnapshot as HookSnapshot;

		expect(trackTaskDependencyCreatedMock).toHaveBeenCalledTimes(1);
		expect(snapshot.board.dependencies).toHaveLength(1);
		expect(snapshot.board.dependencies[0]).toMatchObject({
			fromTaskId: "task-1",
			toTaskId: "task-2",
		});
	});

	it("tracks how many linked tasks were auto-started when a parent task is trashed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const requestAutoStartTasks = vi.fn(async () => ["task-1", "task-3"]);
		const boardFactory = () =>
			createBoard([
				{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 },
				{ id: "dep-2", fromTaskId: "task-3", toTaskId: "task-2", createdAt: 11 },
			]);

		await act(async () => {
			root.render(
				<HookHarness
					boardFactory={boardFactory}
					requestAutoStartTasks={requestAutoStartTasks}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
		});

		expect(requestAutoStartTasks).toHaveBeenCalledWith(["task-1", "task-3"]);
		expect(trackTasksAutoStartedFromDependencyMock).toHaveBeenCalledWith(2);
	});

	it("does not track dependency auto-start telemetry when no task was started", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const requestAutoStartTasks = vi.fn(async () => []);
		const boardFactory = () =>
			createBoard([
				{ id: "dep-1", fromTaskId: "task-1", toTaskId: "task-2", createdAt: 10 },
				{ id: "dep-2", fromTaskId: "task-3", toTaskId: "task-2", createdAt: 11 },
			]);

		await act(async () => {
			root.render(
				<HookHarness
					boardFactory={boardFactory}
					requestAutoStartTasks={requestAutoStartTasks}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
		});

		expect(requestAutoStartTasks).toHaveBeenCalledWith(["task-1", "task-3"]);
		expect(trackTasksAutoStartedFromDependencyMock).not.toHaveBeenCalled();
	});

	it("stops the main task session and its detail terminal shell when a task is trashed", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const stopTaskSession = vi.fn(async (_taskId: string) => {});

		await act(async () => {
			root.render(
				<HookHarness
					stopTaskSession={stopTaskSession}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;
		const reviewTask = initialSnapshot.board.columns.find((column) => column.id === "review")?.cards[0];
		if (!reviewTask) {
			throw new Error("Expected a review task.");
		}

		await act(async () => {
			await initialSnapshot.confirmMoveTaskToTrash(reviewTask, initialSnapshot.board);
		});

		expect(stopTaskSession).toHaveBeenCalledTimes(2);
		expect(stopTaskSession).toHaveBeenNthCalledWith(1, reviewTask.id);
		expect(stopTaskSession).toHaveBeenNthCalledWith(2, getDetailTerminalTaskId(reviewTask.id));
	});

	it("trashes tasks directly through the request handler", async () => {
		let latestSnapshot: HookSnapshot | null = null;
		const cleanupTaskWorkspace = vi.fn(async (_taskId: string) => null);

		await act(async () => {
			root.render(
				<HookHarness
					cleanupTaskWorkspace={cleanupTaskWorkspace}
					onSnapshot={(snapshot) => {
						latestSnapshot = snapshot;
					}}
				/>,
			);
		});

		if (latestSnapshot === null) {
			throw new Error("Expected a hook snapshot.");
		}
		const initialSnapshot = latestSnapshot as HookSnapshot;

		await act(async () => {
			await initialSnapshot.requestMoveTaskToTrash("task-2", "review");
		});

		if (latestSnapshot === null) {
			throw new Error("Expected an updated hook snapshot.");
		}
		const nextSnapshot = latestSnapshot as HookSnapshot;
		expect(nextSnapshot.board.columns.find((column) => column.id === "review")?.cards).toHaveLength(0);
		expect(nextSnapshot.board.columns.find((column) => column.id === "trash")?.cards[0]?.id).toBe("task-2");
		expect(cleanupTaskWorkspace).toHaveBeenCalledWith("task-2");
	});

});
