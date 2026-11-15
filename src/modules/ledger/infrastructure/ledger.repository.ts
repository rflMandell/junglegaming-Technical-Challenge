import { Injectable, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  type LedgerRepositoryPort,
  type GetLedgerQuery,
  type PaginatedLedgerResult,
  type LedgerCursorPayload,
} from '../application/ports/ledger.repository.port';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry.entity';
import { WalletLedgerEntryEntity } from './wallet-ledger-entry.entity';
import { ENTITY_MANAGER_TOKEN } from '../../../infrastructure/database/database.module';

@Injectable()
export class LedgerRepository implements LedgerRepositoryPort {
  constructor(
    @Inject(ENTITY_MANAGER_TOKEN)
    private readonly em: EntityManager,
  ) {}

  async findByWalletWithCursor(query: GetLedgerQuery): Promise<PaginatedLedgerResult> {
    const fork = this.em.fork();
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 100);

    let cursorPayload: LedgerCursorPayload | undefined;
    if (query.cursor) {
      try {
        const decoded = Buffer.from(query.cursor, 'base64').toString('utf8');
        cursorPayload = JSON.parse(decoded);
      } catch {
        cursorPayload = undefined;
      }
    }

    const qb = fork.createQueryBuilder(WalletLedgerEntryEntity, 'e');
    qb.where({ walletId: query.walletId });

    if (cursorPayload?.createdAt && cursorPayload?.id) {
      const cursorDate = new Date(cursorPayload.createdAt);
      qb.andWhere({
        $or: [
          { createdAt: { $lt: cursorDate } },
          {
            $and: [
              { createdAt: cursorDate },
              { id: { $lt: cursorPayload.id } },
            ],
          },
        ],
      });
    }

    qb.orderBy({ createdAt: 'DESC', id: 'DESC' });
    qb.limit(limit + 1);

    const entities = await qb.getResult();

    const hasMore = entities.length > limit;
    const itemsEntities = hasMore ? entities.slice(0, limit) : entities;
    const items = itemsEntities.map((e) => WalletLedgerEntryEntity.toDomain(e));

    let nextCursor: string | undefined;
    if (hasMore && items.length > 0) {
      const lastItem = items[items.length - 1];
      const payload: LedgerCursorPayload = {
        createdAt: lastItem.createdAt.toISOString(),
        id: lastItem.id,
      };
      nextCursor = Buffer.from(JSON.stringify(payload)).toString('base64');
    }

    return {
      items,
      nextCursor,
      hasMore,
    };
  }

  async save(entry: WalletLedgerEntry): Promise<void> {
    const fork = this.em.fork();
    const entity = WalletLedgerEntryEntity.fromDomain(entry);
    await fork.persistAndFlush(entity);
  }

  async countByWalletId(walletId: string): Promise<number> {
    const fork = this.em.fork();
    return await fork.count(WalletLedgerEntryEntity, { walletId });
  }
}
