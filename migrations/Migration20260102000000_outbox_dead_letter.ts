import { Migration } from '@mikro-orm/migrations';

// Evento que o destino recusa sempre não pode ficar tentando para sempre nem inflar o lag da outbox.
export class Migration20260102000000_outbox_dead_letter extends Migration {
  override async up(): Promise<void> {
    this.addSql('alter table outbox_messages add column failed_at timestamptz');
    this.addSql(
      'alter table outbox_messages add constraint outbox_not_published_and_failed check (published_at is null or failed_at is null)',
    );
    this.addSql('drop index outbox_unpublished');
    this.addSql(
      'create index outbox_unpublished on outbox_messages (occurred_at) where published_at is null and failed_at is null',
    );
  }

  override async down(): Promise<void> {
    this.addSql('drop index outbox_unpublished');
    this.addSql('create index outbox_unpublished on outbox_messages (occurred_at) where published_at is null');
    this.addSql('alter table outbox_messages drop constraint outbox_not_published_and_failed');
    this.addSql('alter table outbox_messages drop column failed_at');
  }
}
