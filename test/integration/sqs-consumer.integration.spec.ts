import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import {
  SQSClient,
  ReceiveMessageCommand,
  SendMessageCommand,
  PurgeQueueCommand,
} from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { AppModule } from '../../src/app.module';
import { SQS_CLIENT_TOKEN } from '../../src/infrastructure/messaging/sqs.client';
import { WagerTransactionProducer } from '../../src/infrastructure/messaging/wager-transaction.producer';
import { WagerTransactionConsumer } from '../../src/infrastructure/messaging/wager-transaction.consumer';
import { CreateWalletUseCase } from '../../src/modules/wallet/application/use-cases/create-wallet.use-case';
import { GetWalletUseCase } from '../../src/modules/wallet/application/use-cases/get-wallet.use-case';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind.enum';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction-status.enum';
import { FailureCode } from '../../src/modules/wagering/domain/failure-code.enum';
import { InboxMessageEntity } from '../../src/modules/messaging/infrastructure/inbox-message.entity';
import { WagerTransactionEntity } from '../../src/modules/wagering/infrastructure/wager-transaction.entity';
import { WalletLedgerEntryEntity } from '../../src/modules/ledger/infrastructure/wallet-ledger-entry.entity';
import { ENTITY_MANAGER_TOKEN } from '../../src/infrastructure/database/database.module';

describe('SQS Asynchronous Processing & Inbox Deduplication (Integration)', () => {
  let app: INestApplication;
  let producer: WagerTransactionProducer;
  let consumer: WagerTransactionConsumer;
  let createWalletUseCase: CreateWalletUseCase;
  let getWalletUseCase: GetWalletUseCase;
  let em: EntityManager;
  let sqsClient: SQSClient;

  const mainQueueUrl =
    process.env.SQS_WAGER_TRANSACTIONS_QUEUE_URL ||
    'http://localhost:4566/000000000000/wager-transactions.fifo';
  const dlqUrl =
    process.env.SQS_WAGER_TRANSACTIONS_DLQ_URL ||
    'http://localhost:4566/000000000000/wager-transactions-dlq.fifo';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    producer = app.get(WagerTransactionProducer);
    consumer = app.get(WagerTransactionConsumer);
    createWalletUseCase = app.get(CreateWalletUseCase);
    getWalletUseCase = app.get(GetWalletUseCase);
    em = app.get(ENTITY_MANAGER_TOKEN);
    sqsClient = app.get(SQS_CLIENT_TOKEN);

    // Drain / Purge test queues before starting to ensure clean test state
    try {
      await sqsClient.send(new PurgeQueueCommand({ QueueUrl: mainQueueUrl }));
    } catch {
      // SQS purge has a 60s cooldown; ignore if already purged
    }
  });

  afterAll(async () => {
    if (consumer) {
      await consumer.stop();
    }
    if (app) {
      await app.close();
    }
  });

  it('should publish message to SQS FIFO and process it asynchronously with Inbox persistence', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });

    const providerId = `sqs-provider-${uuidv7().slice(0, 8)}`;
    const externalTransactionId = `ext-sqs-bet-${uuidv7().slice(0, 8)}`;
    const idempotencyKey = `idemp-sqs-${uuidv7()}`;
    const correlationId = uuidv7();

    // 1. Publish transaction to SQS FIFO queue
    const messageId = await producer.publish({
      dto: {
        providerId,
        externalTransactionId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-sqs-1',
        gameId: 'game-slot-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '40.00', currency: 'BRL' },
      },
      idempotencyKey,
      correlationId,
    });

    expect(messageId).toBeDefined();

    // 2. Consume and process message
    const count = await consumer.pollOnce(2);
    expect(count).toBeGreaterThanOrEqual(1);

    // 3. Verify wallet balance was debited (100.00 - 40.00 = 60.00)
    const updatedWallet = await getWalletUseCase.execute(wallet.id);
    expect(updatedWallet.balance.amount).toBe('60.00');

    // 4. Verify transaction state in database
    const fork = em.fork();
    const tx = await fork.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe(WagerTransactionStatus.Processed);
    expect(tx!.idempotencyKey).toBe(idempotencyKey);

    // 5. Verify Inbox message was recorded with processed timestamp
    const inbox = await fork.findOne(InboxMessageEntity, {
      consumerName: consumer.consumerName,
      messageId,
    });
    expect(inbox).not.toBeNull();
    expect(inbox!.processedAt).toBeDefined();

    // 6. Verify message was deleted from SQS (ACKed)
    const receive = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: mainQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    expect(receive.Messages || []).toHaveLength(0);
  });

  it('should safely deduplicate SQS redelivery via Inbox without duplicating debit', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '80.00', currency: 'BRL' },
    });

    const providerId = `sqs-provider-${uuidv7().slice(0, 8)}`;
    const externalTransactionId = `ext-redelivery-${uuidv7().slice(0, 8)}`;
    const idempotencyKey = `idemp-redelivery-${uuidv7()}`;
    const fixedMessageId = `mock-sqs-msg-${uuidv7()}`;
    const receiptHandle = `mock-receipt-${uuidv7()}`;

    const payload = {
      dto: {
        providerId,
        externalTransactionId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-redeliver',
        gameId: 'game-slot-2',
        kind: WagerTransactionKind.Bet,
        money: { amount: '30.00', currency: 'BRL' },
      },
      idempotencyKey,
      correlationId: uuidv7(),
    };

    // First delivery
    const mockMessage = {
      MessageId: fixedMessageId,
      ReceiptHandle: receiptHandle,
      Body: JSON.stringify(payload),
    };

    // Process first time
    const res1 = await consumer.processSingleMessage(mockMessage as any);
    expect(res1).not.toBeNull();
    expect(res1!.status).toBe(WagerTransactionStatus.Processed);
    expect(res1!.balance.amount).toBe('50.00'); // 80 - 30 = 50

    // Redelivery with the exact same MessageId
    const res2 = await consumer.processSingleMessage(mockMessage as any);
    expect(res2).not.toBeNull();
    expect(res2!.idempotentReplay).toBe(true);
    expect(res2!.balance.amount).toBe('50.00'); // Still 50.00!

    // Verify wallet balance remained 50.00
    const walletCheck = await getWalletUseCase.execute(wallet.id);
    expect(walletCheck.balance.amount).toBe('50.00');

    // Verify exactly ONE debit ledger entry exists
    const fork = em.fork();
    const ledgerEntries = await fork.find(WalletLedgerEntryEntity, {
      walletId: wallet.id,
      direction: 'DEBIT',
    });
    expect(ledgerEntries).toHaveLength(1);
    expect(ledgerEntries[0].amount).toBe('30.00');
  });

  it('should process business rejection (insufficient funds) via SQS, record in DB, and ACK', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '25.00', currency: 'BRL' },
    });

    const providerId = `sqs-provider-${uuidv7().slice(0, 8)}`;
    const externalTransactionId = `ext-reject-${uuidv7().slice(0, 8)}`;
    const idempotencyKey = `idemp-reject-${uuidv7()}`;

    // Publish BET exceeding balance (R$ 100.00 > R$ 25.00)
    const messageId = await producer.publish({
      dto: {
        providerId,
        externalTransactionId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-fail-sqs',
        gameId: 'game-slot-1',
        kind: WagerTransactionKind.Bet,
        money: { amount: '100.00', currency: 'BRL' },
      },
      idempotencyKey,
    });

    const count = await consumer.pollOnce(2);
    expect(count).toBeGreaterThanOrEqual(1);

    // Verify wallet balance was NOT altered
    const walletAfter = await getWalletUseCase.execute(wallet.id);
    expect(walletAfter.balance.amount).toBe('25.00');

    // Verify transaction was stored as REJECTED with INSUFFICIENT_FUNDS
    const fork = em.fork();
    const tx = await fork.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId,
    });
    expect(tx).not.toBeNull();
    expect(tx!.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx!.failureCode).toBe(FailureCode.InsufficientFunds);

    // Verify Inbox message was marked as processed
    const inbox = await fork.findOne(InboxMessageEntity, {
      consumerName: consumer.consumerName,
      messageId,
    });
    expect(inbox).not.toBeNull();
    expect(inbox!.processedAt).toBeDefined();

    // Verify message was ACKed from queue (not stuck)
    const receive = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: mainQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    expect(receive.Messages || []).toHaveLength(0);
  });

  it('should process multi-step BET followed by referencing WIN via SQS FIFO in order', async () => {
    const playerId = uuidv7();
    const wallet = await createWalletUseCase.execute({
      playerId,
      initialBalance: { amount: '50.00', currency: 'BRL' },
    });

    const providerId = `sqs-provider-${uuidv7().slice(0, 8)}`;
    const betExtId = `ext-bet-multi-${uuidv7().slice(0, 8)}`;
    const winExtId = `ext-win-multi-${uuidv7().slice(0, 8)}`;

    // 1. Publish BET of 20.00
    await producer.publish({
      dto: {
        providerId,
        externalTransactionId: betExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-multi-1',
        gameId: 'game-roulette',
        kind: WagerTransactionKind.Bet,
        money: { amount: '20.00', currency: 'BRL' },
      },
    });

    // 2. Publish WIN of 80.00 referencing previous BET
    await producer.publish({
      dto: {
        providerId,
        externalTransactionId: winExtId,
        playerId,
        walletId: wallet.id,
        roundId: 'round-multi-1',
        gameId: 'game-roulette',
        kind: WagerTransactionKind.Win,
        money: { amount: '80.00', currency: 'BRL' },
        referenceExternalTransactionId: betExtId,
      },
    });

    // Consume messages (2 messages)
    await consumer.pollOnce(2);
    await consumer.pollOnce(2);

    // Final balance: 50 - 20 + 80 = 110.00
    const finalWallet = await getWalletUseCase.execute(wallet.id);
    expect(finalWallet.balance.amount).toBe('110.00');

    const fork = em.fork();
    const betTx = await fork.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId: betExtId,
    });
    const winTx = await fork.findOne(WagerTransactionEntity, {
      providerId,
      externalTransactionId: winExtId,
    });

    expect(betTx!.status).toBe(WagerTransactionStatus.Processed);
    expect(winTx!.status).toBe(WagerTransactionStatus.Processed);
  });

  it('should route permanently invalid (malformed) payload directly to DLQ and remove from main queue', async () => {
    const malformedBody = '{"corrupted": true, "missingRequiredFields": 123}';

    // Send malformed message directly to main queue
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: mainQueueUrl,
        MessageBody: malformedBody,
        MessageGroupId: 'malformed-group',
        MessageDeduplicationId: `malformed-${uuidv7()}`,
      }),
    );

    // Process via consumer
    const count = await consumer.pollOnce(2);
    expect(count).toBeGreaterThanOrEqual(1);

    // Verify main queue no longer has the message
    const mainReceive = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: mainQueueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
      }),
    );
    expect(mainReceive.Messages || []).toHaveLength(0);

    // Verify message arrived in DLQ
    const dlqReceive = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: 5,
        WaitTimeSeconds: 2,
        MessageAttributeNames: ['All'],
      }),
    );
    expect(dlqReceive.Messages && dlqReceive.Messages.length).toBeGreaterThan(0);
    const dlqMsg = dlqReceive.Messages![0];
    expect(dlqMsg.Body).toBe(malformedBody);
    expect(dlqMsg.MessageAttributes?.DlqReason?.StringValue).toContain('MALFORMED_PAYLOAD');
  });

  it('should start and stop cleanly without leaks during graceful shutdown', async () => {
    consumer.start();
    // Consumer should be running
    await new Promise((resolve) => setTimeout(resolve, 50));
    await consumer.stop();
    // Clean stop achieved
  });
});
