import { adaptLegacyInviteBody, renderTemplate } from './template-renderer';

describe('adaptLegacyInviteBody', () => {
  it('replaces the password line of a customised legacy template with the invite link', () => {
    const body = 'Hi {name},\nTemporary password: {temporary_password}\nBye';
    const adapted = adaptLegacyInviteBody(body, 'en');

    expect(adapted).toBe('Hi {name},\nSet your password here: {reset_link}\nBye');
    expect(renderTemplate(adapted, { name: 'Ana', reset_link: 'https://x/login?token=t' })).not.toContain('{');
  });

  it('uses Spanish wording for Spanish stores', () => {
    expect(adaptLegacyInviteBody('Contraseña: {temporary_password}', 'es-AR')).toBe(
      'Crea tu contraseña aquí: {reset_link}',
    );
  });

  it('leaves a template that already uses the link, or never had a password, untouched', () => {
    expect(adaptLegacyInviteBody('Go: {reset_link}', 'en')).toBe('Go: {reset_link}');
    expect(adaptLegacyInviteBody('Welcome {name}', 'en')).toBe('Welcome {name}');
  });
});
