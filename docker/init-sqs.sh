#!/bin/bash
set -e

echo "Initializing AWS SQS FIFO Queues in LocalStack..."

# Create Dead Letter Queue FIFO
awslocal sqs create-queue \
    --queue-name wager-transactions-dlq.fifo \
    --attributes FifoQueue=true,ContentBasedDeduplication=true

# Get DLQ ARN
DLQ_ARN=$(awslocal sqs get-queue-attributes \
    --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
    --attribute-names QueueArn \
    --query 'Attributes.QueueArn' \
    --output text)

echo "DLQ created with ARN: $DLQ_ARN"

# Create Main FIFO Queue
MAIN_URL=$(awslocal sqs create-queue \
    --queue-name wager-transactions.fifo \
    --attributes FifoQueue=true,ContentBasedDeduplication=false \
    --query 'QueueUrl' \
    --output text)

echo "Main FIFO Queue created at: $MAIN_URL"

# Attach RedrivePolicy
awslocal sqs set-queue-attributes \
    --queue-url "$MAIN_URL" \
    --attributes "{\"RedrivePolicy\": \"{\\\"deadLetterTargetArn\\\": \\\"$DLQ_ARN\\\", \\\"maxReceiveCount\\\": \\\"5\\\"}\"}"

echo "RedrivePolicy attached successfully!"
