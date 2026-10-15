import { registerDecorator, ValidationOptions } from 'class-validator';

/** Caps the serialised size of a free-form JSON value. A plain `@IsObject()` accepts anything up to the request body limit. */
export function MaxJsonSize(maxChars: number, validationOptions?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'maxJsonSize',
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} is too large`, ...validationOptions },
      validator: {
        validate(value: unknown) {
          try {
            return JSON.stringify(value ?? null).length <= maxChars;
          } catch {
            return false;
          }
        },
      },
    });
  };
}
