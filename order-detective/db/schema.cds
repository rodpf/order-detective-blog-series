namespace orderdetective;

using { cuid, managed } from '@sap/cds/common';

/**
 * A customer sales order.
 */
entity Orders : cuid, managed {
  orderNumber : String(10) @mandatory;
  customer    : String(80);
  orderDate   : Date;
  status      : String(20) enum { open; delivered; delayed; cancelled };
  items       : Composition of many OrderItems on items.order = $self;
  delivery    : Composition of one Deliveries on delivery.order = $self;
}

/**
 * Line items belonging to an order.
 */
entity OrderItems : cuid {
  order       : Association to Orders;
  material    : String(40);
  materialDesc: String(80);
  quantity    : Integer;
  unit        : String(10);
}

/**
 * The (single) delivery associated with an order, with planned vs actual dates.
 */
entity Deliveries : cuid {
  order         : Association to Orders;
  plannedDate   : Date;
  actualDate    : Date;
  status        : String(20) enum { onTime; delayed; inTransit; delivered };
  delayReason   : Composition of one DelayReasons on delayReason.delivery = $self;
}

/**
 * Root-cause reason for a delayed delivery.
 */
entity DelayReasons : cuid {
  delivery    : Association to Deliveries;
  reasonCode  : String(10);
  reasonText  : String(200);
  delayDays   : Integer;
}
