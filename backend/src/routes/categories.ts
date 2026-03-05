import { createCrudRouter } from '../helpers/crudRouter';

export default createCrudRouter({
  table: 'categories',
  requiredFields: ['name'],
  defaultValues: { color: '#94a3b8', icon: null },
  updateFields: ['name', 'color', 'icon'],
});
