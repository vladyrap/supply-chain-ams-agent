import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "../utils/logger";
import {
  getSapStatus,
  listPurchaseOrders,
  getPurchaseOrder,
  listSalesOrders,
  getSalesOrder,
  listMaterials,
  getMaterial,
  listMovements,
} from "../services/sap.service";

export async function getStatus(_req: FastifyRequest, reply: FastifyReply) {
  try {
    return reply.send({ success: true, ...(await getSapStatus()) });
  } catch (err) {
    logger.error({ err }, "sap status fail");
    return reply.code(500).send({ success: false, error: "Error consultando SAP status" });
  }
}

export async function getPos(
  req: FastifyRequest<{ Querystring: { vendor?: string; status?: string } }>,
  reply: FastifyReply
) {
  try {
    const data = await listPurchaseOrders({ vendor: req.query.vendor, status: req.query.status });
    return reply.send({ success: true, count: data.length, purchaseOrders: data });
  } catch (err) {
    logger.error({ err }, "sap POs list fail");
    return reply.code(500).send({ success: false, error: "Error listando POs" });
  }
}

export async function getPoDetail(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const po = await getPurchaseOrder(req.params.id);
    if (!po) return reply.code(404).send({ success: false, error: "PO no encontrada" });
    return reply.send({ success: true, purchaseOrder: po });
  } catch (err) {
    logger.error({ err }, "sap PO detail fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo PO" });
  }
}

export async function getSos(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const data = await listSalesOrders();
    return reply.send({ success: true, count: data.length, salesOrders: data });
  } catch (err) {
    logger.error({ err }, "sap SOs list fail");
    return reply.code(500).send({ success: false, error: "Error listando pedidos de venta" });
  }
}

export async function getSoDetail(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) {
  try {
    const so = await getSalesOrder(req.params.id);
    if (!so) return reply.code(404).send({ success: false, error: "Pedido no encontrado" });
    return reply.send({ success: true, salesOrder: so });
  } catch (err) {
    logger.error({ err }, "sap SO detail fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo pedido" });
  }
}

export async function getMaterials(_req: FastifyRequest, reply: FastifyReply) {
  try {
    const data = await listMaterials();
    return reply.send({ success: true, count: data.length, materials: data });
  } catch (err) {
    logger.error({ err }, "sap materials fail");
    return reply.code(500).send({ success: false, error: "Error listando materiales" });
  }
}

export async function getMaterialDetail(
  req: FastifyRequest<{ Params: { matnr: string } }>,
  reply: FastifyReply
) {
  try {
    const m = await getMaterial(req.params.matnr);
    if (!m) return reply.code(404).send({ success: false, error: "Material no encontrado" });
    return reply.send({ success: true, material: m });
  } catch (err) {
    logger.error({ err }, "sap material detail fail");
    return reply.code(500).send({ success: false, error: "Error obteniendo material" });
  }
}

export async function getMovements(
  req: FastifyRequest<{ Querystring: { material?: string; plant?: string } }>,
  reply: FastifyReply
) {
  try {
    const data = await listMovements({ material: req.query.material, plant: req.query.plant });
    return reply.send({ success: true, count: data.length, movements: data });
  } catch (err) {
    logger.error({ err }, "sap movements fail");
    return reply.code(500).send({ success: false, error: "Error listando movimientos" });
  }
}
