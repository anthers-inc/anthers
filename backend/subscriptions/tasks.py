from celery import shared_task


@shared_task(name="subscriptions.distribute_pool")
def distribute_pool():
    """Distribute creator pool and boost allocations for the billing cycle.

    Implemented in Phase 4C.
    """
    pass


@shared_task(name="subscriptions.aggregate_attention")
def aggregate_attention():
    """Aggregate attention events per creator per subscriber for pool calculation.

    Implemented in Phase 4C.
    """
    pass
