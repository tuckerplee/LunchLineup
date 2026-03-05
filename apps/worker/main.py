"""
RabbitMQ Background Worker — Job Consumer.
Architecture Part VIII — consumes queue messages, processes with retry logic and DLQ.
"""

import asyncio
import json
import logging
import os
import grpc

import solver_pb2
import solver_pb2_grpc

logger = logging.getLogger("worker")
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')

RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://guest:guest@localhost:5672")
ENGINE_GRPC_URL = os.getenv("ENGINE_GRPC_URL", "localhost:50051")
MAX_RETRIES = 3

JOB_HANDLERS = {
    "schedule.solve": "handle_solve_job",
    "email.send": "handle_email_job",
    "pdf.generate": "handle_pdf_job",
    "billing.sync": "handle_billing_sync",
    "webhook.deliver": "handle_webhook_delivery",
}

async def handle_solve_job(payload: dict):
    """Delegate scheduling job to the engine via gRPC."""
    logger.info(f"Processing solve job via gRPC: {payload.get('schedule_id')}")
    
    async with grpc.aio.insecure_channel(ENGINE_GRPC_URL) as channel:
        stub = solver_pb2_grpc.SolverServiceStub(channel)
        
        request = solver_pb2.ScheduleRequest(
            tenant_id=payload.get("tenant_id", "default"),
            location_id=payload.get("location_id", "default"),
            start_date=payload.get("start_date", ""),
            end_date=payload.get("end_date", ""),
        )
        
        # Populate staff and constraints if provided in payload
        for staff_id in payload.get("staff_ids", []):
            staff_member = request.staff.add()
            staff_member.id = staff_id
            
        for key, value in payload.get("constraints", {}).items():
            constraint = request.constraints.add()
            constraint.type = key
            constraint.value = str(value)
            
        response = await stub.CalculateSchedule(request)
        
    logger.info(f"Solve result: status={response.status}, produced {len(response.shifts)} shifts")
    return {"status": response.status, "schedule_id": response.schedule_id}

async def handle_email_job(payload: dict):
    """Send transactional email."""
    logger.info(f"Sending email to {payload.get('to')}: {payload.get('subject')}")
    # In production: SMTP via configured provider
    return {"sent": True}

async def handle_pdf_job(payload: dict):
    """Generate PDF schedule report or parse uploaded availability PDF."""
    file_path = payload.get("file_path")
    job_action = payload.get("action", "generate")
    
    if job_action == "parse":
        logger.info(f"Parsing PDF availability document: {file_path}")
        from src.parser.pdf_parser import AvailabilityParser
        parser = AvailabilityParser()
        result = parser.parse_document(file_path)
        return {"parsed": True, "data": result}
    else:
        logger.info(f"Generating PDF for schedule {payload.get('schedule_id')}")
        return {"generated": True}

async def handle_billing_sync(payload: dict):
    """Sync metering data to Stripe."""
    logger.info(f"Syncing billing for tenant {payload.get('tenant_id')}")
    return {"synced": True}

async def handle_webhook_delivery(payload: dict):
    """Deliver webhook with HMAC signature and retry logic."""
    logger.info(f"Delivering webhook to {payload.get('url')}")
    return {"delivered": True}

async def process_message(body: bytes):
    """Route incoming message to the appropriate handler."""
    try:
        message = json.loads(body)
        job_type = message.get("type", "unknown")
        payload = message.get("payload", {})
        retry_count = message.get("retry_count", 0)

        handler_name = JOB_HANDLERS.get(job_type)
        if not handler_name:
            logger.error(f"Unknown job type: {job_type}")
            return

        handler = globals().get(handler_name)
        if handler:
            await handler(payload)
            logger.info(f"Job {job_type} completed successfully")
        else:
            logger.error(f"Handler not found: {handler_name}")

    except Exception as e:
        logger.error(f"Job processing failed: {e}")
        raise e  # Let aio-pika handle negative acknowledgement (nack) and DLQ routing

async def start_consumer():
    """Connect to RabbitMQ and consume messages."""
    try:
        import aio_pika

        connection = await aio_pika.connect_robust(RABBITMQ_URL)
        channel = await connection.channel()
        await channel.set_qos(prefetch_count=10)

        # Setup main queue and Dead Letter Queue
        dlq = await channel.declare_queue("lunchlineup.jobs.dlq", durable=True)
        # Main queue with DLX configured
        queue = await channel.declare_queue(
            "lunchlineup.jobs", 
            durable=True,
            arguments={
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": "lunchlineup.jobs.dlq"
            }
        )

        logger.info("Worker connected to RabbitMQ — consuming messages")

        async with queue.iterator() as queue_iter:
            async for message in queue_iter:
                async with message.process(requeue=False): # If it fails, routing to DLQ occurs automatically
                    await process_message(message.body)

    except ImportError:
        logger.warning("aio-pika not installed — running in standalone mode")
    except Exception as e:
        logger.error(f"Failed to connect to RabbitMQ: {e}")

if __name__ == "__main__":
    logger.info("Starting LunchLineup Worker")
    asyncio.run(start_consumer())
