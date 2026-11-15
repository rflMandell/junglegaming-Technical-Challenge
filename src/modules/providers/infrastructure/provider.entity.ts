import { Entity, PrimaryKey, Property } from '@mikro-orm/core';

@Entity({ tableName: 'providers' })
export class ProviderEntity {
  @PrimaryKey({ type: 'string', length: 64 })
  id!: string;

  @Property({ type: 'string', length: 255 })
  name!: string;

  @Property({ type: 'boolean', default: true })
  active: boolean = true;

  @Property({ type: 'timestamptz', defaultRaw: 'NOW()' })
  createdAt: Date = new Date();

  @Property({ type: 'timestamptz', defaultRaw: 'NOW()', onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
