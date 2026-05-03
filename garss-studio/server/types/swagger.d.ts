declare module "swagger-jsdoc" {
  type SwaggerJSDocOptions = {
    definition: Record<string, unknown>;
    apis: string[];
  };

  export default function swaggerJsdoc(options: SwaggerJSDocOptions): Record<string, unknown>;
}

declare module "swagger-ui-express" {
  import type { RequestHandler } from "express";

  type SwaggerUiOptions = {
    explorer?: boolean;
    swaggerOptions?: Record<string, unknown>;
  };

  const swaggerUi: {
    serve: RequestHandler[];
    setup(spec: Record<string, unknown>, options?: SwaggerUiOptions): RequestHandler;
  };

  export default swaggerUi;
}
