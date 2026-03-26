import { useCallback, useEffect, useState } from "react";

import type { RuntimeTaskSessionSummary } from "@/runtime/types";
import { findCardSelection } from "@/state/board-state";
import type { BoardData, BoardDependency } from "@/types";

interface UseTaskStartActionsInput {
	board: BoardData;
	handleCreateTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	handleStartTask: (taskId: string) => void;
	handleStartAllBacklogTasks: (taskIds?: string[]) => void;
}

export interface UseTaskStartActionsResult {
	handleCreateAndStartTask: (options?: { keepDialogOpen?: boolean }) => string | null;
	handleCreateAndStartTasks: (prompts: string[], options?: { keepDialogOpen?: boolean }) => string[];
	handleStartTaskFromBoard: (taskId: string) => void;
	handleStartAllBacklogTasksFromBoard: () => void;
}

interface GetAutoStartableBacklogTaskIdsInput {
	board: BoardData;
	sessions: Record<string, RuntimeTaskSessionSummary>;
	maxConcurrentRunningTasks: number;
	requestedTaskIds?: string[];
	reservedTaskIds?: Iterable<string>;
	excludedTaskIds?: Iterable<string>;
}

export function getStartableBacklogTaskIds(board: BoardData): string[] {
	const backlogCards = board.columns.find((column) => column.id === "backlog")?.cards ?? [];
	const inProgressCards = board.columns.find((column) => column.id === "in_progress")?.cards ?? [];
	const backlogTaskIds = new Set(backlogCards.map((card) => card.id));
	const inProgressTaskIds = new Set(inProgressCards.map((card) => card.id));
	const dependencyByBacklogTaskId = new Map<string, BoardDependency>();

	for (const dependency of board.dependencies) {
		if (!dependencyByBacklogTaskId.has(dependency.fromTaskId)) {
			dependencyByBacklogTaskId.set(dependency.fromTaskId, dependency);
		}
	}

	const startableTaskIds: string[] = [];
	for (const card of backlogCards) {
		const dependency = dependencyByBacklogTaskId.get(card.id);
		if (!dependency) {
			startableTaskIds.push(card.id);
			continue;
		}

		if (!backlogTaskIds.has(dependency.toTaskId) && !inProgressTaskIds.has(dependency.toTaskId)) {
			startableTaskIds.push(card.id);
		}
	}

	return startableTaskIds;
}

export function countRunningTaskSessions(sessions: Record<string, RuntimeTaskSessionSummary>): number {
	return Object.values(sessions).filter((summary) => summary.state === "running").length;
}

export function getAutoStartableBacklogTaskIds({
	board,
	sessions,
	maxConcurrentRunningTasks,
	requestedTaskIds,
	reservedTaskIds,
	excludedTaskIds,
}: GetAutoStartableBacklogTaskIdsInput): string[] {
	const reservedTaskIdSet = new Set(reservedTaskIds ?? []);
	const excludedTaskIdSet = new Set(excludedTaskIds ?? []);
	const availableSlots = Math.max(
		0,
		maxConcurrentRunningTasks - countRunningTaskSessions(sessions) - reservedTaskIdSet.size,
	);
	if (availableSlots === 0) {
		return [];
	}

	const requestedTaskIdSet = requestedTaskIds ? new Set(requestedTaskIds) : null;
	const startableTaskIds = getStartableBacklogTaskIds(board);
	const autoStartableTaskIds: string[] = [];

	for (const taskId of startableTaskIds) {
		if (reservedTaskIdSet.has(taskId)) {
			continue;
		}
		if (excludedTaskIdSet.has(taskId)) {
			continue;
		}
		if (requestedTaskIdSet && !requestedTaskIdSet.has(taskId)) {
			continue;
		}
		autoStartableTaskIds.push(taskId);
		if (autoStartableTaskIds.length >= availableSlots) {
			break;
		}
	}

	return autoStartableTaskIds;
}

export function useTaskStartActions({
	board,
	handleCreateTask,
	handleCreateTasks,
	handleStartTask,
	handleStartAllBacklogTasks,
}: UseTaskStartActionsInput): UseTaskStartActionsResult {
	const [pendingTaskStartAfterCreateIds, setPendingTaskStartAfterCreateIds] = useState<string[] | null>(null);

	const startBacklogTasks = useCallback(
		(taskIds: string[]) => {
			const backlogTaskIds = [...new Set(taskIds.filter((taskId) => taskId.trim().length > 0))].filter((taskId) => {
				const selection = findCardSelection(board, taskId);
				return selection?.column.id === "backlog";
			});

			if (backlogTaskIds.length === 0) {
				return;
			}

			if (backlogTaskIds.length === 1) {
				const firstTaskId = backlogTaskIds[0];
				if (!firstTaskId) {
					return;
				}
				handleStartTask(firstTaskId);
				return;
			}
			handleStartAllBacklogTasks(backlogTaskIds);
		},
		[board, handleStartAllBacklogTasks, handleStartTask],
	);

	const handleStartTaskFromBoard = useCallback(
		(taskId: string) => {
			const selection = findCardSelection(board, taskId);
			if (!selection || selection.column.id !== "backlog") {
				handleStartTask(taskId);
				return;
			}
			startBacklogTasks([taskId]);
		},
		[board, handleStartTask, startBacklogTasks],
	);

	const handleStartAllBacklogTasksFromBoard = useCallback(() => {
		const backlogTaskIds = getStartableBacklogTaskIds(board);

		if (backlogTaskIds.length === 0) {
			return;
		}
		startBacklogTasks(backlogTaskIds);
	}, [board, startBacklogTasks]);

	const handleCreateAndStartTask = useCallback((options?: { keepDialogOpen?: boolean }): string | null => {
		const taskId = handleCreateTask(options);
		if (!taskId) {
			return null;
		}
		setPendingTaskStartAfterCreateIds([taskId]);
		return taskId;
	}, [handleCreateTask]);

	const handleCreateAndStartTasks = useCallback(
		(prompts: string[], options?: { keepDialogOpen?: boolean }): string[] => {
			const taskIds = handleCreateTasks(prompts, options);
			if (taskIds.length === 0) {
				return [];
			}
			setPendingTaskStartAfterCreateIds(taskIds);
			return taskIds;
		},
		[handleCreateTasks],
	);

	useEffect(() => {
		if (!pendingTaskStartAfterCreateIds || pendingTaskStartAfterCreateIds.length === 0) {
			return;
		}
		const allInBacklog = pendingTaskStartAfterCreateIds.every((taskId) => {
			const selection = findCardSelection(board, taskId);
			return selection?.column.id === "backlog";
		});
		if (!allInBacklog) {
			return;
		}
		startBacklogTasks(pendingTaskStartAfterCreateIds);
		setPendingTaskStartAfterCreateIds(null);
	}, [board, pendingTaskStartAfterCreateIds, startBacklogTasks]);

	return {
		handleCreateAndStartTask,
		handleCreateAndStartTasks,
		handleStartTaskFromBoard,
		handleStartAllBacklogTasksFromBoard,
	};
}
