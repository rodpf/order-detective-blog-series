using { orderdetective as db } from '../db/schema';

@protocol: ['odata', 'mcp']
service OrderService {

  entity Orders       as projection on db.Orders;
  entity OrderItems   as projection on db.OrderItems;
  entity Deliveries   as projection on db.Deliveries;
  entity DelayReasons as projection on db.DelayReasons;

  /**
   * Single-call composite trace: order -> delivery -> delay reason.
   * This is the function the agent calls as its main MCP tool.
   */
  function traceOrder(orderNumber : String) returns {
    orderNumber    : String;
    customer       : String;
    orderStatus    : String;
    plannedDate    : Date;
    actualDate     : Date;
    deliveryStatus : String;
    delayDays      : Integer;
    delayReason    : String;
    daysOverdue    : Integer;
  };
}

// Custom instructions sent to agents when they connect to this MCP server
annotate OrderService with @mcp.instructions:
  'Use traceOrder with an orderNumber to get the full delivery/delay trace for one order. Use query to search Orders, Deliveries or DelayReasons directly.';
