import { describe, expect, it } from "vitest";

import {
	countRunningTaskSessions,
	getAutoStartableBacklogTaskIds,
	getStartableBacklogTaskIds,
} from "@/hooks/use-task-start-actions";
import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import type { BoardCard, BoardData, BoardDependency } from "@/types";

describe("getStartableBacklogTaskIds", () => {
	function createCard(id: string, prompt = "Do something"): BoardCard {
		return {
			id,
			prompt,
			startInPlanMode: false,
			autoReviewEnabled: false,
			autoReviewMode: "commit",
			baseRef: "main",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
	}

	function createBoard({
		backlogCards,
		dependencies = [],
		inProgressCards = [],
	}: {
		backlogCards: BoardCard[];
		dependencies?: BoardDependency[];
		inProgressCards?: BoardCard[];
	}): BoardData {
		return {
			columns: [
				{ id: "backlog", title: "Backlog", cards: backlogCards },
				{ id: "in_progress", title: "In Progress", cards: inProgressCards },
				{ id: "review", title: "Review", cards: [] },
				{ id: "trash", title: "Trash", cards: [] },
			],
			dependencies,
		};
	}

	function createRunningSession(taskId: string): RuntimeTaskSessionSummary {
		return {
			taskId,
			state: "running",
			agentId: "codex",
			workspacePath: "/tmp/repo",
			pid: 1234,
			startedAt: 1,
			updatedAt: 1,
			lastOutputAt: 1,
			reviewReason: null,
			exitCode: null,
			lastHookAt: null,
			latestHookActivity: null,
			latestTurnCheckpoint: null,
			previousTurnCheckpoint: null,
		};
	}

	it("returns all backlog task ids when there are no dependencies", () => {
		const board = createBoard({ backlogCards: [createCard("task-1"), createCard("task-2"), createCard("task-3")] });
		expect(getStartableBacklogTaskIds(board)).toEqual(["task-1", "task-2", "task-3"]);
	});

	it("returns empty array when backlog is empty", () => {
		const board = createBoard({ backlogCards: [] });
		expect(getStartableBacklogTaskIds(board)).toEqual([]);
	});

	it("excludes a parent task whose child is also in the backlog", () => {
		const board = createBoard({
			backlogCards: [createCard("task-a"), createCard("task-b")],
			dependencies: [{ id: "dep-1", fromTaskId: "task-a", toTaskId: "task-b", createdAt: 1 }],
		});
		expect(getStartableBacklogTaskIds(board)).toEqual(["task-b"]);
	});

	it("excludes a parent task whose child is in progress", () => {
		const board = createBoard({
			backlogCards: [createCard("task-a")],
			dependencies: [{ id: "dep-1", fromTaskId: "task-a", toTaskId: "task-b", createdAt: 1 }],
			inProgressCards: [createCard("task-b")],
		});
		expect(getStartableBacklogTaskIds(board)).toEqual([]);
	});

	it("counts only running task sessions toward the auto-start cap", () => {
		expect(
			countRunningTaskSessions({
				"task-1": createRunningSession("task-1"),
				"task-2": {
					...createRunningSession("task-2"),
					state: "awaiting_review",
				},
			}),
		).toBe(1);
	});

	it("limits auto-start selection by remaining running-task capacity", () => {
		const board = createBoard({
			backlogCards: [createCard("task-1"), createCard("task-2"), createCard("task-3")],
		});

		expect(
			getAutoStartableBacklogTaskIds({
				board,
				sessions: { "running-task": createRunningSession("running-task") },
				maxConcurrentRunningTasks: 2,
			}),
		).toEqual(["task-1"]);
	});

	it("filters dependency-unblocked auto-start requests in backlog order", () => {
		const board = createBoard({
			backlogCards: [createCard("task-1"), createCard("task-2"), createCard("task-3")],
		});

		expect(
			getAutoStartableBacklogTaskIds({
				board,
				sessions: {},
				maxConcurrentRunningTasks: 2,
				requestedTaskIds: ["task-3", "task-2"],
			}),
		).toEqual(["task-2", "task-3"]);
	});

	it("does not reselect reserved tasks while auto-start is already in flight", () => {
		const board = createBoard({
			backlogCards: [createCard("task-1"), createCard("task-2"), createCard("task-3")],
		});

		expect(
			getAutoStartableBacklogTaskIds({
				board,
				sessions: {},
				maxConcurrentRunningTasks: 2,
				reservedTaskIds: ["task-1"],
			}),
		).toEqual(["task-2"]);
	});
});
