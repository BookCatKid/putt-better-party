import { randomInt } from 'node:crypto';
import type { Browse, CatalogPage } from './domain.js';

const PAGE_SIZE = 24;
const MAX_CATALOG_SIZE = 10_000;
const MAX_DAILY_PAGES = 500;

export async function featuredDailyIds(browse: Browse, currentDay: number): Promise<Set<string>> {
  const featuredIds = new Set<string>();
  let offset: number | null = 0;
  const visitedOffsets = new Set<number>();

  while (offset !== null) {
    if (visitedOffsets.has(offset) || visitedOffsets.size >= MAX_DAILY_PAGES) {
      throw new Error('Invalid daily catalog pagination');
    }
    visitedOffsets.add(offset);

    const page = await browse({ sort: 'new', offset, daily: true, fresh: true });
    if (!Array.isArray(page.holes) || !('nextOffset' in page)) {
      throw new Error('Daily catalog unavailable');
    }

    for (const hole of page.holes) {
      if (
        typeof hole.id === 'string' &&
        (typeof hole.scheduledDay !== 'number' ||
          !Number.isFinite(hole.scheduledDay) ||
          hole.scheduledDay <= currentDay)
      ) {
        featuredIds.add(hole.id);
      }
    }
    if (
      page.nextOffset !== null &&
      (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset)
    ) {
      throw new Error('Invalid daily catalog pagination');
    }
    offset = page.nextOffset;
  }
  return featuredIds;
}

interface RandomSelectionOptions {
  browse: Browse;
  count: number;
  seen?: string[];
  pick?: (maximum: number) => number;
  excludeDaily?: boolean;
  currentDay?: number;
}

/** Draw uniformly shuffled catalog positions; only retrieve pages as needed. */
export async function chooseRandom({
  browse,
  count,
  seen = [],
  pick = randomInt,
  excludeDaily = false,
  currentDay = Infinity,
}: RandomSelectionOptions): Promise<{ ids: string[]; seen: string[] }> {
  const excluded = excludeDaily ? await featuredDailyIds(browse, currentDay) : new Set<string>();
  const getPage = (offset: number) => browse({ sort: 'new', offset, fresh: excludeDaily });
  const firstPage = await getPage(0);
  const total = firstPage.total;

  if (!Number.isInteger(total) || total < count || total > MAX_CATALOG_SIZE) {
    throw new Error('Not enough public courses');
  }

  const history = new Set(seen);
  const pages = new Map<number, CatalogPage>([[0, firstPage]]);
  const selectedIds: string[] = [];
  const availablePositions = Array.from({ length: total }, (_unused, index) => index);
  const deferredIds: string[] = [];

  while (selectedIds.length < count && availablePositions.length) {
    const position = availablePositions.splice(pick(availablePositions.length), 1)[0];
    const offset = Math.floor(position / PAGE_SIZE) * PAGE_SIZE;

    let page = pages.get(offset);
    if (!page) {
      page = await getPage(offset);
      pages.set(offset, page);
    }
    const hole = page.holes[position - offset];
    const id = hole?.id;
    if (!id) {
      continue;
    }
    const scheduledDay = hole.scheduledDay;
    const wasFeatured =
      typeof scheduledDay === 'number' &&
      Number.isFinite(scheduledDay) &&
      scheduledDay <= currentDay;
    if (excludeDaily && (excluded.has(id) || wasFeatured)) {
      continue;
    }
    if (selectedIds.includes(id) || deferredIds.includes(id)) {
      continue;
    }
    if (history.has(id)) {
      deferredIds.push(id);
    } else {
      selectedIds.push(id);
      history.add(id);
    }
  }

  if (selectedIds.length < count) {
    // Exhausted the old pool. Begin another cycle: the old history is reset,
    // but every course played in this match counts toward the new cycle so a
    // follow-up match cannot immediately repeat it.
    history.clear();
    for (const id of selectedIds) {
      history.add(id);
    }
    for (const id of deferredIds) {
      if (selectedIds.length >= count) {
        break;
      }
      selectedIds.push(id);
      history.add(id);
    }
  }

  if (selectedIds.length !== count) {
    throw new Error(
      excludeDaily
        ? 'Not enough non-daily public holes available; change the filter or hole count'
        : 'Public catalog changed while selecting holes; retry',
    );
  }
  return { ids: selectedIds, seen: [...history] };
}
