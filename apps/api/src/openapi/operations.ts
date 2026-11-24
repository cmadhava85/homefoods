/** All route contracts. Every Fastify route must appear here (enforced by openapi.test.ts). */
import type { ApiOperation } from "./registry.js";
import { accountOperations } from "../plugins/accountRoutes.contract.js";
import { adminOperations } from "../plugins/adminRoutes.contract.js";
import { authOperations } from "../plugins/authRoutes.contract.js";
import { cateringOperations } from "../plugins/cateringRoutes.contract.js";
import { cookOperations } from "../plugins/cookRoutes.contract.js";
import { customerOperations } from "../plugins/customerRoutes.contract.js";
import { internalOperations } from "../plugins/internalRoutes.contract.js";
import { logisticsOperations } from "../plugins/logisticsWebhook.contract.js";
import { metaOperations } from "../plugins/metaRoutes.contract.js";
import { paymentOperations } from "../plugins/paymentRoutes.contract.js";
import { uploadsOperations } from "../plugins/uploadsRoutes.contract.js";
import { whatsappOperations } from "../plugins/whatsappWebhook.contract.js";

export const allOperations: ApiOperation[] = [
  ...metaOperations,
  ...authOperations,
  ...accountOperations,
  ...customerOperations,
  ...cookOperations,
  ...adminOperations,
  ...cateringOperations,
  ...internalOperations,
  ...paymentOperations,
  ...whatsappOperations,
  ...logisticsOperations,
  ...uploadsOperations,
];
