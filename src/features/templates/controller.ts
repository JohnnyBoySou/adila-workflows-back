import { templatesService } from "./service";
import type {
  CheckoutTemplateBody,
  InstallTemplateBody,
  ListTemplatesQuery,
  RateTemplateBody,
} from "./schema";

export const templatesController = {
  list(organizationId: string, query: ListTemplatesQuery) {
    return templatesService.list(organizationId, query);
  },

  findById(organizationId: string, id: string) {
    return templatesService.findById(organizationId, id);
  },

  install(organizationId: string, userId: string, id: string, body: InstallTemplateBody) {
    return templatesService.install(organizationId, userId, id, body);
  },

  checkout(organizationId: string, userId: string, id: string, body: CheckoutTemplateBody) {
    return templatesService.createCheckout(organizationId, userId, id, body);
  },

  rate(organizationId: string, userId: string, id: string, body: RateTemplateBody) {
    return templatesService.rateTemplate(organizationId, userId, id, body);
  },

  listRatings(id: string) {
    return templatesService.listRatings(id);
  },

  handleWebhook(rawBody: string, signature: string | null) {
    return templatesService.handleWebhook(rawBody, signature);
  },
};
