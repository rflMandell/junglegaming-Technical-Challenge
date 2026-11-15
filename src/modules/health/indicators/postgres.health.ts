import { Injectable, Inject } from '@nestjs/common';
import { HealthIndicatorResult } from '@nestjs/terminus';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import { MIKRO_ORM_TOKEN } from '../../../infrastructure/database/database.module';

@Injectable()
export class PostgresHealthIndicator {
  constructor(
    @Inject(MIKRO_ORM_TOKEN)
    private readonly orm: MikroORM<PostgreSqlDriver>,
  ) {}

  async isHealthy(key = 'postgres'): Promise<HealthIndicatorResult> {
    try {
      const isConnected = await this.orm.isConnected();
      if (!isConnected) {
        return {
          [key]: {
            status: 'down',
            message: 'PostgreSQL connection is not established',
          },
        };
      }
      // Execute a lightweight query to confirm query execution capability
      await this.orm.em.fork().getConnection().execute('SELECT 1');
      return {
        [key]: {
          status: 'up',
        },
      };
    } catch (error) {
      return {
        [key]: {
          status: 'down',
          message: error instanceof Error ? error.message : 'Unknown database error',
        },
      };
    }
  }
}
