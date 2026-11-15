import { Module, Global, Inject, OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import { PostgreSqlDriver } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../../mikro-orm.config';

export const MIKRO_ORM_TOKEN = 'MIKRO_ORM';
export const ENTITY_MANAGER_TOKEN = 'ENTITY_MANAGER';

@Global()
@Module({
  providers: [
    {
      provide: MIKRO_ORM_TOKEN,
      useFactory: async () => {
        return await MikroORM.init<PostgreSqlDriver>(mikroOrmConfig);
      },
    },
    {
      provide: ENTITY_MANAGER_TOKEN,
      useFactory: (orm: MikroORM<PostgreSqlDriver>) => {
        return orm.em.fork();
      },
      inject: [MIKRO_ORM_TOKEN],
    },
  ],
  exports: [MIKRO_ORM_TOKEN, ENTITY_MANAGER_TOKEN],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(MIKRO_ORM_TOKEN)
    private readonly orm: MikroORM<PostgreSqlDriver>,
  ) {}

  async onApplicationShutdown() {
    if (this.orm) {
      await this.orm.close();
    }
  }
}
