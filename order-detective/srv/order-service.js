import cds from '@sap/cds'

export default class OrderService extends cds.ApplicationService {
  async init() {
    const { Orders } = this.entities

    this.on('traceOrder', async (req) => {
      const { orderNumber } = req.data

      const order = await SELECT.one
        .from(Orders, (o) => {
          o.orderNumber, o.customer, o.status
          o.delivery((d) => {
            d.plannedDate, d.actualDate, d.status,
            d.delayReason((r) => {
              r.delayDays, r.reasonText
            })
          })
        })
        .where({ orderNumber })

      if (!order) {
        req.error(404, `No order found with number ${orderNumber}`)
        return
      }

      // Deterministic "is this actually overdue" fact, computed here instead
      // of leaving it for an LLM consumer to infer from dates - an LLM has no
      // reliable notion of "today" on its own, and inferring lateness from a
      // planned date invites confident wrong answers. Only meaningful when
      // there's no actualDate yet (order not yet delivered): positive = days
      // past the planned date and still not delivered, negative = days
      // remaining before it's even due, zero = due today. null once
      // actualDate exists - delayDays/deliveryStatus already tell that part
      // of the story, this field would be redundant there.
      let daysOverdue = null
      if (order.delivery?.plannedDate && !order.delivery?.actualDate) {
        const planned = new Date(order.delivery.plannedDate)
        const today = new Date()
        daysOverdue = Math.floor((today - planned) / (1000 * 60 * 60 * 24))
      }

      return {
        orderNumber   : order.orderNumber,
        customer      : order.customer,
        orderStatus   : order.status,
        plannedDate   : order.delivery?.plannedDate,
        actualDate    : order.delivery?.actualDate,
        deliveryStatus: order.delivery?.status,
        delayDays     : order.delivery?.delayReason?.delayDays ?? 0,
        delayReason   : order.delivery?.delayReason?.reasonText ?? 'No delay recorded',
        daysOverdue
      }
    })

    return super.init()
  }
}
