import math
from decimal import ROUND_HALF_UP, Decimal


def calculate_fees(amount: Decimal) -> dict:
    """Calculate transparent fee breakdown for a purchase.

    Returns dict with: processing_fee, crf_fee, creator_earnings, application_fee_cents.
    """
    processing_fee = (amount * Decimal("0.029") + Decimal("0.30")).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    crf_fee = (amount * Decimal("0.03")).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP
    )
    creator_earnings = amount - processing_fee - crf_fee

    # Stripe application_fee_amount is in cents — this is the CRF the platform retains
    application_fee_cents = int(math.ceil(crf_fee * 100))

    return {
        "processing_fee": processing_fee,
        "crf_fee": crf_fee,
        "creator_earnings": creator_earnings,
        "application_fee_cents": application_fee_cents,
    }
